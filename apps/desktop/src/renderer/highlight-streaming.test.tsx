// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { cachedHighlight, highlight, useHighlight } from './highlight.js'
import { languageByName } from './languages.js'

const ts = languageByName('ts')!

describe('流式输出中的代码块高亮', () => {
  it('中间结果不写缓存；可以指定更小的长度上限', async () => {
    const code = 'const streaming = 1'
    expect(await highlight(code, ts, { cache: false })).toHaveLength(1)
    expect(cachedHighlight(code, ts)).toBeUndefined()
    expect(await highlight('x'.repeat(11), ts, { maxChars: 10 })).toBeUndefined()
  })

  it('新结果出来之前，沿用上一次结果中已经写完的行', async () => {
    const first = 'const a = 1\nconst b'
    const { result, rerender } = renderHook(
      ({ code }) => useHighlight(code, ts, { streaming: true }),
      { initialProps: { code: first } },
    )
    await waitFor(() => expect(result.current).toHaveLength(2), { timeout: 5000 })
    expect(cachedHighlight(first, ts)).toBeUndefined()
    rerender({ code: `${first} = 2\nconst c = 3` })
    // 第二行变长了，只沿用第一行
    expect(result.current).toHaveLength(1)
    await waitFor(() => expect(result.current).toHaveLength(3), { timeout: 5000 })
  })

  it('节流等待期间卸载会取消尚未执行的高亮', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const { rerender, unmount } = renderHook(
        ({ code }) => useHighlight(code, ts, { streaming: true }),
        { initialProps: { code: 'const a = 1' } },
      )
      // 第一次高亮已开始（lastRun=1000），第二次变更落在 250ms 窗口内，走定时器分支
      now.mockReturnValue(1_100)
      rerender({ code: 'const a = 1\nconst b = 2' })
      expect(() => unmount()).not.toThrow()
    } finally {
      now.mockRestore()
    }
  })

  it('不是前缀时不沿用旧结果', async () => {
    const { result, rerender } = renderHook(
      ({ code }) => useHighlight(code, ts, { streaming: true }),
      { initialProps: { code: 'let x = 1' } },
    )
    await waitFor(() => expect(result.current).toHaveLength(1), { timeout: 5000 })
    rerender({ code: 'var y = 2' })
    expect(result.current).toBeUndefined()
  })
})
