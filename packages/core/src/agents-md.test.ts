import { describe, expect, it } from 'vitest'
import {
  AGENTS_MD_MAX_BYTES,
  AGENTS_MD_TRUNCATION_NOTE,
  countLines,
  decodeAgentsMd,
  utf8PrefixEnd,
} from './agents-md.js'

const text = (value: string) => new TextEncoder().encode(value)

describe('decodeAgentsMd', () => {
  it('keeps a file within the limit and counts lines', () => {
    const bytes = text('第一行\n第二行\n')
    expect(decodeAgentsMd(bytes, bytes.length)).toEqual({
      text: '第一行\n第二行',
      included: bytes,
      truncated: false,
      lines: 2,
    })
    expect(countLines('')).toBe(0)
    expect(countLines('一行')).toBe(1)
  })

  it('decodes an emoji and replaces invalid bytes', () => {
    const emoji = text('😀')
    expect(decodeAgentsMd(emoji, emoji.length)?.text).toBe('😀')
    // 断掉的三字节、空字节、过长编码。空字节去掉，其余换成替换字符。
    const broken = new Uint8Array([0xe4, 0x20, 0x00, 0xc0, 0x80])
    expect(decodeAgentsMd(broken, broken.length)?.text).toBe('\uFFFD \uFFFD')
  })

  it('returns undefined for a blank file', () => {
    const bytes = text('  \n\t')
    expect(decodeAgentsMd(bytes, bytes.length)).toBeUndefined()
  })

  it('truncates on a character boundary and notes the cut', () => {
    const bytes = new Uint8Array(AGENTS_MD_MAX_BYTES + 2)
    bytes.fill(0x61)
    bytes[AGENTS_MD_MAX_BYTES - 1] = 0xe4
    bytes[AGENTS_MD_MAX_BYTES] = 0xb8
    bytes[AGENTS_MD_MAX_BYTES + 1] = 0xad
    expect(utf8PrefixEnd(bytes, AGENTS_MD_MAX_BYTES)).toBe(AGENTS_MD_MAX_BYTES - 1)
    const decoded = decodeAgentsMd(bytes, bytes.length)
    expect(decoded?.truncated).toBe(true)
    expect(decoded?.included.length).toBe(AGENTS_MD_MAX_BYTES - 1)
    expect(decoded?.text.endsWith(AGENTS_MD_TRUNCATION_NOTE)).toBe(true)
    expect(decoded?.text.includes('\uFFFD')).toBe(false)
    expect(decoded?.lines).toBe(1)
  })
})
