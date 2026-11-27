import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createIconService,
  ICON_MAX_BYTES,
  iconLinksOf,
  pagesOf,
  sniffImage,
} from './icon-service.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])
const SVG = Buffer.from(
  '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
)
const dataOf = (mime: string, body: Buffer) => `data:${mime};base64,${body.toString('base64')}`

type Routes = Record<string, Buffer | string | number>

/** 按地址返回固定内容；数字是 HTTP 状态码，没有的地址返回 404。 */
function fakeFetch(routes: Routes) {
  return vi.fn(async (input: URL | string, _init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined) return new Response('missing', { status: 404 })
    if (typeof route === 'number') return new Response(null, { status: route })
    return new Response(typeof route === 'string' ? route : new Uint8Array(route), {
      headers: {
        'content-type': typeof route === 'string' ? 'text/html' : 'application/octet-stream',
      },
    })
  })
}

let cacheDir: string
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-icons-'))
})
afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('icon service (ADR-0049)', () => {
  it('recognizes images by their content', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(ICO)).toBe('image/x-icon')
    expect(sniffImage(SVG)).toBe('image/svg+xml')
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('GIF89a..'))).toBe('image/gif')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Buffer.from('<!doctype html><html>'))).toBeUndefined()
    expect(sniffImage(Buffer.from('ab'))).toBeUndefined()
  })

  it('reads icon links like a browser and ranks the best first', () => {
    const html = `<head>
      <link rel="stylesheet" href="/a.css">
      <link rel="shortcut icon" href="/favicon-16.png" sizes="16x16">
      <link href='/apple.png' rel='apple-touch-icon'>
      <link rel=icon href=/logo-64.png sizes="64x64">
      <link rel="icon" href="https://cdn.example.com/logo.svg?v=1&amp;x=2">
      <link rel="icon" href="http://insecure.example.com/i.png">
      <link rel="icon" href="">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="icon" href="http://[bad">
      <link rel="icon" href="/plain.ico">
    </head>`
    expect(iconLinksOf(html, 'https://www.example.com/docs/')).toEqual([
      'https://cdn.example.com/logo.svg?v=1&x=2',
      'https://www.example.com/apple.png',
      'https://www.example.com/logo-64.png',
      'data:image/png;base64,AAAA',
      'https://www.example.com/plain.ico',
      'https://www.example.com/favicon-16.png',
    ])
  })

  it('tries the website, the key page, then the API host and its parent domain', () => {
    expect(
      pagesOf({
        homepage: 'https://www.example.com/',
        keysUrl: 'https://console.example.com/keys',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toEqual([
      'https://www.example.com/',
      'https://console.example.com/keys',
      'https://api.example.com/',
      'https://example.com/',
    ])
    // 本机服务与 http 地址没有网站图标可找
    expect(pagesOf({ baseUrl: 'http://localhost:11434/v1' })).toEqual([])
    expect(pagesOf({ baseUrl: 'https://192.168.1.2/v1', homepage: 'https://ollama.com' })).toEqual([
      'https://ollama.com/',
    ])
    expect(pagesOf({ baseUrl: 'https://example.com/v1' })).toEqual(['https://example.com/'])
  })

  it('returns inline icons as they are and downloads https icons', async () => {
    const fetch = fakeFetch({ 'https://cdn.example.com/acme.png': PNG })
    const service = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const inline = dataOf('image/png', PNG)
    await expect(service.resolve({ icon: inline })).resolves.toEqual({ dataUrl: inline })
    await expect(service.resolve({ icon: 'https://cdn.example.com/acme.png' })).resolves.toEqual({
      dataUrl: dataOf('image/png', PNG),
    })
    const accept = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(accept['accept']).not.toContain('avif')
  })

  it('falls back from a broken icon to the site favicon, and caches the result on disk', async () => {
    const routes: Routes = {
      'https://cdn.example.com/broken.png': Buffer.from('<html>not an image</html>'),
      'https://www.example.com/': '<link rel="icon" href="/brand.svg">',
      'https://www.example.com/brand.svg': SVG,
    }
    const fetch = fakeFetch(routes)
    const source = {
      icon: 'https://cdn.example.com/broken.png',
      homepage: 'https://www.example.com',
    }
    const first = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const [a, b] = await Promise.all([first.resolve(source), first.resolve(source)])
    expect(a).toEqual({ dataUrl: dataOf('image/svg+xml', SVG) })
    expect(b).toEqual(a)
    const calls = fetch.mock.calls.length
    expect(calls).toBe(3)
    // 新的服务实例（重启后）读磁盘缓存，不再联网
    const again = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(again.resolve(source)).resolves.toEqual(a)
    expect(fetch.mock.calls.length).toBe(calls)
  })

  it('uses /favicon.ico when the page has no icon links or cannot be opened', async () => {
    const fetch = fakeFetch({
      'https://openrouter.ai/': '<html><head><title>x</title></head></html>',
      'https://openrouter.ai/favicon.ico': ICO,
      'https://down.example.com/favicon.ico': PNG,
    })
    const service = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(service.resolve({ homepage: 'https://openrouter.ai' })).resolves.toEqual({
      dataUrl: dataOf('image/x-icon', ICO),
    })
    await expect(service.resolve({ homepage: 'https://down.example.com/' })).resolves.toEqual({
      dataUrl: dataOf('image/png', PNG),
    })
  })

  it('remembers a missing icon for a day, then tries again', async () => {
    let now = 1_000
    const routes: Routes = {}
    const fetch = fakeFetch(routes)
    const service = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
    })
    const source = { baseUrl: 'https://api.example.org/v1' }
    await expect(service.resolve(source)).resolves.toEqual({})
    const calls = fetch.mock.calls.length
    await expect(service.resolve(source)).resolves.toEqual({})
    expect(fetch.mock.calls.length).toBe(calls)
    routes['https://example.org/favicon.ico'] = PNG
    now += 25 * 60 * 60 * 1000
    await expect(service.resolve(source)).resolves.toEqual({ dataUrl: dataOf('image/png', PNG) })
  })

  it('skips local servers, oversized images and corrupt cache files', async () => {
    const fetch = fakeFetch({
      'https://big.example.com/favicon.ico': Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)]),
    })
    const service = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
      concurrency: 1,
    })
    await expect(service.resolve({ baseUrl: 'http://localhost:11434/v1' })).resolves.toEqual({})
    expect(fetch).not.toHaveBeenCalled()
    await expect(service.resolve({ homepage: 'https://big.example.com' })).resolves.toEqual({})
    for (const file of fs.readdirSync(cacheDir)) {
      fs.writeFileSync(path.join(cacheDir, file), '{"at":"bad"}')
    }
    const fresh = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(fresh.resolve({ homepage: 'https://big.example.com' })).resolves.toEqual({})
    // 同时请求多个来源时排队，结果互不影响
    const results = await Promise.all(
      ['a', 'b', 'c'].map((name) => service.resolve({ homepage: `https://${name}.example.net` })),
    )
    expect(results).toEqual([{}, {}, {}])
  })

  it('still answers when the cache directory cannot be written', async () => {
    const file = path.join(cacheDir, 'not-a-dir')
    fs.writeFileSync(file, 'x')
    const fetch = fakeFetch({ 'https://x.example.com/favicon.ico': PNG })
    const service = createIconService({
      cacheDir: file,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(service.resolve({ homepage: 'https://x.example.com' })).resolves.toEqual({
      dataUrl: dataOf('image/png', PNG),
    })
  })

  it('finds icons declared in the head of a page larger than the read limit', async () => {
    const page = `<head><link rel="apple-touch-icon" href="/touch.png"></head>${'x'.repeat(600 * 1024)}`
    const fetch = fakeFetch({
      'https://www.big-site.example/': page,
      'https://www.big-site.example/touch.png': PNG,
    })
    const service = createIconService({
      cacheDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(service.resolve({ homepage: 'https://www.big-site.example' })).resolves.toEqual({
      dataUrl: dataOf('image/png', PNG),
    })
  })
})
