import { describe, expect, it } from 'vitest'
import {
  buildMemoryContext,
  MEMORY_CONTEXT_MAX_BYTES,
  MEMORY_SCOPE_ORDER,
  type MemoryContextEntry,
} from './memory-context.js'

const entry = (
  scope: MemoryContextEntry['scope'],
  content: string,
  updatedAt = 1,
): MemoryContextEntry => ({ scope, content, updatedAt })

describe('buildMemoryContext', () => {
  it('按会话 → 项目 → 全局排列', () => {
    expect(MEMORY_SCOPE_ORDER).toEqual(['session', 'project', 'global'])
    const built = buildMemoryContext([
      entry('global', '全局偏好'),
      entry('session', '本会话约定'),
      entry('project', '项目约定'),
    ])
    expect(built.text).toBe(
      [
        '## Session',
        '- 本会话约定',
        '',
        '## Project',
        '- 项目约定',
        '',
        '## Global',
        '- 全局偏好',
      ].join('\n'),
    )
    expect(built.included).toBe(3)
    expect(built.dropped).toBe(0)
    expect(built.truncated).toBe(false)
    expect(built.bytes).toBe(new TextEncoder().encode(built.text).length)
  })

  it('同一内容只保留最靠前的范围', () => {
    const built = buildMemoryContext([
      entry('session', '  用 pnpm  '),
      entry('project', '用   pnpm'),
      entry('global', '提交信息用中文'),
    ])
    expect(built.text).toContain('## Session\n- 用 pnpm')
    expect(built.text).not.toContain('## Project')
    expect(built.included).toBe(2)
    expect(built.dropped).toBe(0)
  })

  it('跳过空内容，没有可用条目时不产生正文', () => {
    expect(buildMemoryContext([])).toEqual({ included: 0, dropped: 0, truncated: false, bytes: 0 })
    expect(buildMemoryContext([entry('session', '   ')])).toEqual({
      included: 0,
      dropped: 0,
      truncated: false,
      bytes: 0,
    })
  })

  it('超出上限时先裁掉最久没有更新的条目并注明条数', () => {
    const built = buildMemoryContext(
      [
        entry('session', 'a'.repeat(20), 10),
        entry('session', 'b'.repeat(20), 30),
        entry('project', 'c'.repeat(20), 20),
      ],
      { maxBytes: 70 },
    )
    // 两条子标题各 11 字节、每条正文 23 字节：只放得下最新的两条（b、c），最旧的 a 被裁掉。
    expect(built.included).toBe(2)
    expect(built.dropped).toBe(1)
    expect(built.truncated).toBe(true)
    expect(built.text).toContain('bbbb')
    expect(built.text).toContain('cccc')
    expect(built.text).not.toContain('aaaa')
    expect(
      built.text?.endsWith(
        '[Trimmed: 1 older memory entry was left out to fit the 70-byte memory limit.]',
      ),
    ).toBe(true)
  })

  it('一条都放不下时没有正文，但仍报告裁剪', () => {
    const built = buildMemoryContext([entry('session', 'x'.repeat(200))], { maxBytes: 10 })
    expect(built).toEqual({ included: 0, dropped: 1, truncated: true, bytes: 0 })
  })

  it('字节数按 UTF-8 计算，中文不会按字符数少算', () => {
    const built = buildMemoryContext([entry('session', '中文')], { maxBytes: 4 })
    // "## Session\n- 中文\n" 共 21 字节：超过 4 字节上限，放不下。
    expect(built.included).toBe(0)
    expect(built.dropped).toBe(1)
  })

  it('默认上限是 4 KB', () => {
    expect(MEMORY_CONTEXT_MAX_BYTES).toBe(4 * 1024)
    const many = Array.from({ length: 300 }, (_, index) =>
      entry('session', `${index}`.padEnd(20, 'x'), index),
    )
    const built = buildMemoryContext(many)
    expect(built.truncated).toBe(true)
    expect(built.included).toBeGreaterThan(0)
    expect(built.bytes).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_BYTES + 120)
  })
})
