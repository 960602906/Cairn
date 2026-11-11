import { describe, expect, it } from 'vitest'
import { tokenize, trimUrl } from './composer-tokens.js'

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
