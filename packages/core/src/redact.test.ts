import { describe, expect, it } from 'vitest'
import { createRedactor, redact, REDACTED } from './redact.js'

const R = REDACTED

describe('redact: key formats', () => {
  it.each([
    ['OpenAI / DeepSeek', 'key sk-proj-AbCdEf0123456789abcdEF used', `key ${R} used`],
    ['DeepSeek short form', 'sk-0123456789abcdef0123456789abcdef', R],
    ['Anthropic', 'x sk-ant-api03-AbC_dEf-0123456789abcdefGHIJ y', `x ${R} y`],
    ['Google', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', R],
    ['GitHub', 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', R],
    ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', R],
    ['AWS', 'AKIAIOSFODNN7EXAMPLE', R],
    ['Slack', 'xoxb-1234567890-abcdefghij', R],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      R,
    ],
  ])('%s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected)
  })

  it('leaves ordinary text alone', () => {
    const text = 'sk-short task-list key=session.title maxTokens: 4096 /api/home/feed sessionId=s1'
    expect(redact(text)).toBe(text)
  })
})

describe('redact: headers and credentials in text', () => {
  it('redacts Authorization headers', () => {
    expect(redact('Authorization: Bearer abc.DEF-123_456~xyz')).toBe(`Authorization: Bearer ${R}`)
    expect(redact('authorization: basic dXNlcjpwYXNzd29yZA==')).toBe(`authorization: basic ${R}`)
    expect(redact('curl -H "Authorization: Token 0123456789abcdef"')).toBe(
      `curl -H "Authorization: Token ${R}"`,
    )
  })

  it('redacts token parameters in URLs', () => {
    expect(redact('GET https://api.example.com/v1/models?key=AbCdEf123&alt=json')).toBe(
      `GET https://api.example.com/v1/models?key=${R}&alt=json`,
    )
    expect(redact('wss://x.io/socket?user=1&access_token=abc123#frag')).toBe(
      `wss://x.io/socket?user=1&access_token=${R}#frag`,
    )
    expect(redact('https://s3/x?X-Amz-Signature=deadbeef&sig=cafe')).toBe(
      'https://s3/x?X-Amz-Signature=deadbeef&sig=' + R,
    )
  })

  it('redacts name=value and JSON-like pairs', () => {
    expect(redact('password=hunter22 user=lan')).toBe(`password=${R} user=lan`)
    expect(redact('{"api_key": "abc123", "model": "deepseek"}')).toBe(
      `{"api_key": "${R}", "model": "deepseek"}`,
    )
    expect(redact("secret: 'p@ss word'")).toBe(`secret: '${R}'`)
    expect(redact('X-Api-Key: abcdef12')).toBe(`X-Api-Key: ${R}`)
  })
})

describe('redact: known secrets', () => {
  it('replaces configured secrets verbatim, longest first', () => {
    const r = createRedactor({ secrets: ['my-local-key-123', 'my-local-key-123456', 'short'] })
    expect(r('a my-local-key-123456 b my-local-key-123 c short')).toBe(`a ${R} b ${R} c short`)
  })
})

describe('redact: home directories', () => {
  it('replaces generic Windows and POSIX home paths', () => {
    expect(redact(String.raw`open C:\Users\lan\code\app.ts failed`)).toBe(
      String.raw`open ~\code\app.ts failed`,
    )
    expect(redact('d:/users/lan/x')).toBe('~/x')
    expect(redact(String.raw`{"path":"C:\\Users\\lan\\a.txt"}`)).toBe(
      String.raw`{"path":"~\\a.txt"}`,
    )
    expect(redact('cd /home/lan/project && ls /Users/Lan Li')).toBe('cd ~/project && ls ~ Li')
    expect(redact('file:///home/lan/x https://x.com/home/feed')).toBe(
      'file:///home/lan/x https://x.com/home/feed',
    )
  })

  it('replaces configured home directories in any separator style', () => {
    const r = createRedactor({ homeDirs: ['D:\\profiles\\lan\\', '/var/lib/lan', '/'] })
    expect(r(String.raw`D:\profiles\lan\work`)).toBe(String.raw`~\work`)
    expect(r('d:/Profiles/LAN/work')).toBe('~/work')
    expect(r(String.raw`"D:\\profiles\\lan\\x"`)).toBe(String.raw`"~\\x"`)
    expect(r('/var/lib/lan/data and /var/lib/lanx')).toBe('~/data and /var/lib/lanx')
    expect(r('/var/lib/LAN/data')).toBe('/var/lib/LAN/data')
  })
})

describe('redact: values', () => {
  it('walks nested objects and arrays, redacting sensitive keys', () => {
    const input = {
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'plain-key' },
      headers: { Authorization: 'whatever', 'x-goog-api-key': 'g', accept: 'json' },
      usage: { inputTokens: 10, token: 3 },
      refreshToken: 'r',
      list: ['sk-0123456789abcdef0123', 1, null, true, undefined],
    }
    expect(redact(input)).toEqual({
      provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: R },
      headers: { Authorization: R, 'x-goog-api-key': R, accept: 'json' },
      usage: { inputTokens: 10, token: 3 },
      refreshToken: R,
      list: [R, 1, null, true, undefined],
    })
    // 不修改输入
    expect(input.provider.apiKey).toBe('plain-key')
  })

  it('converts errors and redacts message, stack and cause', () => {
    const error = new Error('failed with sk-0123456789abcdef0123', {
      cause: new Error('at /home/lan/x'),
    })
    const out = redact({ error }) as unknown as {
      error: { name: string; message: string; stack: string; cause: { message: string } }
    }
    expect(out.error.name).toBe('Error')
    expect(out.error.message).toBe(`failed with ${R}`)
    expect(out.error.stack).not.toContain('sk-0123')
    expect(out.error.cause.message).toBe('at ~/x')

    const bare = new Error('x')
    delete bare.stack
    expect(redact(bare)).toEqual({ name: 'Error', message: 'x' })
  })

  it('marks cycles but keeps shared references', () => {
    const shared = { a: 1 }
    const node: Record<string, unknown> = { left: shared, right: shared }
    node.self = node
    expect(redact(node)).toEqual({ left: { a: 1 }, right: { a: 1 }, self: '[Circular]' })
  })

  it('keeps non-plain objects and primitives as they are', () => {
    const date = new Date(0)
    const map = new Map([['k', 'v']])
    expect(redact(date)).toBe(date)
    expect(redact(map)).toBe(map)
    expect(redact(42)).toBe(42)
    const bare = Object.create(null) as Record<string, unknown>
    bare.password = 'x'
    expect(redact(bare)).toEqual({ password: R })
  })
})
