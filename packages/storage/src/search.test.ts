import type { ContentPart, PersistedEvent } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  contentText,
  matchesQuery,
  normalizeQuery,
  searchableText,
  searchSnippet,
} from './search.js'

const content = (parts: unknown): readonly ContentPart[] => parts as readonly ContentPart[]
const event = (type: string, parts: unknown) =>
  ({ type, payload: { content: parts } }) as unknown as PersistedEvent

describe('contentText', () => {
  it('keeps text parts, skips images, and treats blank content as empty', () => {
    expect(
      contentText(
        content([
          { type: 'text', text: ' 修复 ' },
          { type: 'image', data: '…', mediaType: 'image/png' },
          { type: 'text', text: '登录 ' },
        ]),
      ),
    ).toBe('修复 登录')
    expect(contentText(content([{ type: 'image', data: '…' }]))).toBeUndefined()
    expect(contentText(content([{ type: 'text', text: '   ' }]))).toBeUndefined()
  })
})

describe('searchableText', () => {
  it('indexes completed messages only', () => {
    expect(searchableText(event('message.user', [{ type: 'text', text: '你好' }]))).toBe('你好')
    expect(
      searchableText(event('message.assistant.completed', [{ type: 'text', text: '你好！' }])),
    ).toBe('你好！')
    expect(
      searchableText(event('message.assistant.delta', [{ type: 'text', text: '你好' }])),
    ).toBeUndefined()
    expect(
      searchableText(event('tool.output.completed', [{ type: 'text', text: '输出' }])),
    ).toBeUndefined()
  })
})

describe('matchesQuery', () => {
  it('requires every term, case-insensitively, and rejects blank queries', () => {
    expect(matchesQuery('修复 Login 失败', '修复 login')).toBe(true)
    expect(matchesQuery('修复 Login 失败', '修复 注册')).toBe(false)
    expect(matchesQuery('修复 Login 失败', '   ')).toBe(false)
  })
})

describe('searchSnippet', () => {
  it('flattens whitespace and adds ellipses around a hit near the middle', () => {
    const text = `${'x'.repeat(10)}\n\n登录${'y'.repeat(10)}`
    expect(searchSnippet(text, '登录', 3)).toBe('…xx 登录yyy…')
  })

  it('does not add ellipses when the hit is at the start or the text is short', () => {
    expect(searchSnippet('登录失败', '登录')).toBe('登录失败')
    expect(searchSnippet('出错的登录页面', '登录', 100)).toBe('出错的登录页面')
  })

  it('falls back to the start of the text when the query is not present', () => {
    expect(searchSnippet('没有命中', '别处', 100)).toBe('没有命中')
  })
})

describe('normalizeQuery', () => {
  it('trims and collapses whitespace, and blanks become undefined', () => {
    expect(normalizeQuery('  修复 \n 登录 ')).toBe('修复 登录')
    expect(normalizeQuery(' \t ')).toBeUndefined()
  })
})
