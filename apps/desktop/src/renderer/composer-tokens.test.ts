import { describe, expect, it } from 'vitest'
import {
  activeMention,
  extractMentions,
  MAX_MENTIONS,
  mentionText,
  parseMention,
  tokenize,
  trimUrl,
} from './composer-tokens.js'

const commands = ['plan', 'model']
const shape = (text: string) =>
  tokenize(text, { commands }).map((token) => [token.type, token.text] as const)

describe('tokenize', () => {
  it('returns nothing for an empty draft and plain text as one token', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('你好')).toEqual([{ type: 'text', text: '你好', start: 0, end: 2 }])
  })

  it('keeps every character: tokens join back into the draft', () => {
    const draft = '/plan 看 https://a.dev/x, 再跑 `pnpm test`\n```ts\nconst a = 1\n```\n完'
    const tokens = tokenize(draft, { commands })
    expect(tokens.map((token) => token.text).join('')).toBe(draft)
    expect(tokens.every((token) => draft.slice(token.start, token.end) === token.text)).toBe(true)
  })

  it('recognises a known command only at the very start', () => {
    expect(shape('/plan')).toEqual([['command', '/plan']])
    expect(shape('/plan 重构输入框')).toEqual([
      ['command', '/plan'],
      ['text', ' 重构输入框'],
    ])
    expect(shape('/model\n下一行')).toEqual([
      ['command', '/model'],
      ['text', '\n下一行'],
    ])
    expect(shape('/unknown 参数')).toEqual([['text', '/unknown 参数']])
    expect(shape('/planx')).toEqual([['text', '/planx']])
    expect(shape(' /plan')).toEqual([['text', ' /plan']])
    expect(shape('先 /plan')).toEqual([['text', '先 /plan']])
    expect(tokenize('/plan').map((token) => token.type)).toEqual(['text'])
  })

  it('finds urls and leaves sentence punctuation outside', () => {
    expect(shape('见 https://a.dev/x。然后')).toEqual([
      ['text', '见 '],
      ['url', 'https://a.dev/x'],
      ['text', '。然后'],
    ])
    expect(shape('(http://a.dev/wiki/A_(b))')).toEqual([
      ['text', '('],
      ['url', 'http://a.dev/wiki/A_(b)'],
      ['text', ')'],
    ])
    expect(shape('https://a.dev https://b.dev')).toEqual([
      ['url', 'https://a.dev'],
      ['text', ' '],
      ['url', 'https://b.dev'],
    ])
    expect(shape('打开https://a.dev/x看看')).toEqual([
      ['text', '打开'],
      ['url', 'https://a.dev/x'],
      ['text', '看看'],
    ])
    expect(shape('https:// 和 ftp://a.dev')).toEqual([['text', 'https:// 和 ftp://a.dev']])
    expect(shape('https:///x')).toEqual([['text', 'https:///x']])
  })

  it('treats inline and fenced code as opaque', () => {
    expect(shape('跑 `curl https://a.dev` 看看')).toEqual([
      ['text', '跑 '],
      ['code', '`curl https://a.dev`'],
      ['text', ' 看看'],
    ])
    expect(shape('```\nhttps://a.dev\n`x`\n```')).toEqual([
      ['code', '```\nhttps://a.dev\n`x`\n```'],
    ])
    expect(shape('没闭合的 `反引号\n下一行`')).toEqual([['text', '没闭合的 `反引号\n下一行`']])
    expect(shape('https://a.dev `x` https://b.dev')).toEqual([
      ['url', 'https://a.dev'],
      ['text', ' '],
      ['code', '`x`'],
      ['text', ' '],
      ['url', 'https://b.dev'],
    ])
  })
})

describe('trimUrl', () => {
  it('drops trailing punctuation and unbalanced closing brackets', () => {
    expect(trimUrl('https://a.dev/x.')).toBe('https://a.dev/x')
    expect(trimUrl('https://a.dev/x?!')).toBe('https://a.dev/x')
    expect(trimUrl('https://a.dev/x)].')).toBe('https://a.dev/x')
    expect(trimUrl('https://a.dev/(x)')).toBe('https://a.dev/(x)')
    expect(trimUrl('https://a.dev/[x]{y}')).toBe('https://a.dev/[x]{y}')
    expect(trimUrl('https://a.dev/x/')).toBe('https://a.dev/x/')
  })
})

describe('mentions', () => {
  it('recognises @path at the start or after whitespace', () => {
    expect(shape('@src/a.ts 看看')).toEqual([
      ['mention', '@src/a.ts'],
      ['text', ' 看看'],
    ])
    expect(shape('看 @src/a.ts:12-30')).toEqual([
      ['text', '看 '],
      ['mention', '@src/a.ts:12-30'],
    ])
    // 邮箱和词中间的 @ 不算
    expect(shape('a@b.com')).toEqual([['text', 'a@b.com']])
    expect(shape('@')).toEqual([['text', '@']])
  })

  it('drops trailing punctuation and keeps quoted paths with spaces', () => {
    expect(shape('看 @a.ts，然后')).toEqual([
      ['text', '看 '],
      ['mention', '@a.ts'],
      ['text', '，然后'],
    ])
    expect(shape('@a.ts: 行')).toEqual([
      ['mention', '@a.ts'],
      ['text', ': 行'],
    ])
    expect(shape('@"my docs/a b.md":3。')).toEqual([
      ['mention', '@"my docs/a b.md":3'],
      ['text', '。'],
    ])
    expect(shape('@"" x')).toEqual([['text', '@"" x']])
    expect(shape('@，')).toEqual([['text', '@，']])
  })

  it('ignores @ inside code and lets a mention win over a URL inside it', () => {
    expect(shape('`@a.ts` @b.ts')).toEqual([
      ['code', '`@a.ts`'],
      ['text', ' '],
      ['mention', '@b.ts'],
    ])
    expect(shape('@https://a.dev/x')).toEqual([['mention', '@https://a.dev/x']])
  })

  it('parses paths and line ranges', () => {
    expect(parseMention('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(parseMention('src/a.ts:12')).toEqual({ path: 'src/a.ts', lines: { start: 12, end: 12 } })
    expect(parseMention('a.ts:3-9')).toEqual({ path: 'a.ts', lines: { start: 3, end: 9 } })
    // 倒过来的范围和 0 行不算行号
    expect(parseMention('a.ts:9-3')).toEqual({ path: 'a.ts' })
    expect(parseMention('a.ts:0')).toEqual({ path: 'a.ts' })
    expect(parseMention('"a b/c.md":2')).toEqual({ path: 'a b/c.md', lines: { start: 2, end: 2 } })
    expect(parseMention(':12')).toBeUndefined()
    expect(parseMention('a"b')).toBeUndefined()
  })

  it('extracts unique mentions from a draft, at most MAX_MENTIONS', () => {
    expect(extractMentions('看 @a.ts 和 @a.ts，还有 @src/ 和 @a.ts:1-2')).toEqual([
      { path: 'a.ts' },
      { path: 'src/' },
      { path: 'a.ts', lines: { start: 1, end: 2 } },
    ])
    const many = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `@f${i}.ts`).join(' ')
    expect(extractMentions(many)).toHaveLength(MAX_MENTIONS)
    expect(extractMentions('没有引用')).toEqual([])
  })

  it('finds the mention being typed at the caret', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMention('看 @src/co', 9)).toEqual({ start: 2, query: 'src/co' })
    expect(activeMention('看 @"my do', 9)).toEqual({ start: 2, query: 'my do' })
    expect(activeMention('看 @src x', 9)).toBeUndefined()
    expect(activeMention('a@b', 3)).toBeUndefined()
    // 光标在一个词的中间
    expect(activeMention('@src', 2)).toBeUndefined()
    expect(activeMention('@sr 后面', 3)).toEqual({ start: 0, query: 'sr' })
  })

  it('writes the chosen entry back as text', () => {
    expect(mentionText('src/a.ts', 'file')).toBe('@src/a.ts ')
    expect(mentionText('src', 'dir')).toBe('@src/ ')
    expect(mentionText('src/', 'dir')).toBe('@src/ ')
    expect(mentionText('my docs/a.md', 'file')).toBe('@"my docs/a.md" ')
  })
})
