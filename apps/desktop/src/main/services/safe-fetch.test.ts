import { describe, expect, it, vi } from 'vitest'
import { isPublicHost, safeFetch, SafeFetchError } from './safe-fetch.js'

const respond = (body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}) =>
  new Response(body, init)

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SafeFetchError)
    return (error as SafeFetchError).reason
  }
  throw new Error('expected a failure')
}

describe('safe fetch (ADR-0050)', () => {
  it('tells public hosts from local and private ones', () => {
    for (const host of ['example.com', 'api.deepseek.com', '8.8.8.8', '[2606:4700::1111]']) {
      expect(isPublicHost(host), host).toBe(true)
    }
    for (const host of [
      '',
      'localhost',
      'intranet',
      'printer.local',
      'app.localhost',
      'router.lan',
      'box.internal',
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
      '::',
    ]) {
      expect(isPublicHost(host), host).toBe(false)
    }
  })

  it('reads a response within the limits and follows public redirects', async () => {
    const fetch = vi.fn(async (url: URL | string, _init?: RequestInit) =>
      String(url) === 'https://a.example.com/'
        ? respond(null, { status: 301, headers: { location: '/next' } })
        : respond('hello', { headers: { 'content-type': 'Text/Plain' } }),
    )
    const result = await safeFetch('https://a.example.com/', {
      fetch: fetch as unknown as typeof globalThis.fetch,
      accept: 'text/plain',
      maxBytes: 10,
      timeoutMs: 1000,
    })
    expect(result).toEqual({
      url: 'https://a.example.com/next',
      contentType: 'text/plain',
      body: Buffer.from('hello'),
    })
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
  })

  it('refuses http, private hosts, credentials and redirects into the local network', async () => {
    const fetch = vi.fn(async () =>
      respond(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
    )
    const options = {
      fetch: fetch as unknown as typeof globalThis.fetch,
      accept: '*/*',
      maxBytes: 10,
      timeoutMs: 1000,
    }
    expect(await reasonOf(safeFetch('http://example.com/', options))).toBe('blocked')
    expect(await reasonOf(safeFetch('https://192.168.0.1/', options))).toBe('blocked')
    expect(await reasonOf(safeFetch('https://u:p@example.com/', options))).toBe('blocked')
    expect(await reasonOf(safeFetch('not a url', options))).toBe('blocked')
    expect(await reasonOf(safeFetch('https://example.com/', options))).toBe('blocked')
    expect(fetch).toHaveBeenCalledTimes(1)
    // 测试或开发时可以放开
    const local = vi.fn(async () => respond('ok'))
    await expect(
      safeFetch('http://127.0.0.1:9/x', {
        ...options,
        fetch: local as unknown as typeof globalThis.fetch,
        publicOnly: false,
        allowHttp: true,
      }),
    ).resolves.toMatchObject({ body: Buffer.from('ok') })
  })

  it('reports HTTP errors, network errors, oversized bodies and redirect loops', async () => {
    const make = (handler: () => Promise<Response>) => ({
      fetch: handler as unknown as typeof globalThis.fetch,
      accept: '*/*',
      maxBytes: 4,
      timeoutMs: 1000,
    })
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => respond('', { status: 404 })),
        ),
      ),
    ).toBe('status')
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => {
            throw new TypeError('offline')
          }),
        ),
      ),
    ).toBe('network')
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => respond('abc', { headers: { 'content-length': '999' } })),
        ),
      ),
    ).toBe('too_large')
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => respond('too long body')),
        ),
      ),
    ).toBe('too_large')
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => respond(null, { status: 302, headers: { location: '/again' } })),
        ),
      ),
    ).toBe('blocked')
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => respond(null, { status: 302 })),
        ),
      ),
    ).toBe('status')
    await expect(
      safeFetch(
        'https://x.example.com/',
        make(async () => respond(null)),
      ),
    ).resolves.toMatchObject({ body: Buffer.alloc(0) })
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new Error('reset'))
      },
    })
    expect(
      await reasonOf(
        safeFetch(
          'https://x.example.com/',
          make(async () => respond(broken)),
        ),
      ),
    ).toBe('network')
  })

  it('returns only the beginning of a long page when asked to truncate', async () => {
    const options = (body: string, headers: Record<string, string> = {}) => ({
      fetch: (async () => respond(body, { headers })) as unknown as typeof globalThis.fetch,
      accept: 'text/html',
      maxBytes: 5,
      timeoutMs: 1000,
      truncate: true,
    })
    await expect(
      safeFetch('https://x.example.com/', options('<head>long page')),
    ).resolves.toMatchObject({ body: Buffer.from('<head') })
    await expect(
      safeFetch('https://x.example.com/', options('<head>long', { 'content-length': '10' })),
    ).resolves.toMatchObject({ body: Buffer.from('<head') })
  })
})
