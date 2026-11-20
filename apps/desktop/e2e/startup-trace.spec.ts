/**
 * 启动计时（PR0，启动优化）：只在 `CAIRN_STARTUP_TRACE=1` 时运行。
 *
 * 主进程打点来自 `src/main/startup-trace.ts`（`globalThis.__cairnStartup.snapshot()`）；渲染进程的
 * 细粒度 mark 只在开发构建里记录，构建产物里只保留 `data-cairn-ready`（首屏可输入的时间点）。
 * 结果作为 JSON 附件写入测试报告，用于对比优化前后的冷/暖启动。
 */
import { expect, test } from './app.js'

const enabled = process.env['CAIRN_STARTUP_TRACE'] === '1'

interface Mark {
  readonly name: string
  readonly at: number
}

interface Snapshot {
  readonly enabled: boolean
  readonly marks: readonly Mark[]
}

test.skip(!enabled, '需要 CAIRN_STARTUP_TRACE=1 记录启动计时')

test('启动计时：主进程打点与首屏可输入时间', async ({ launch }, testInfo) => {
  const { app, window } = await launch({ env: { CAIRN_STARTUP_TRACE: '1' } })

  // e2e 的 tsconfig 不带 DOM 类型，页面内脚本用字符串传入。
  await window.waitForFunction('document.documentElement.dataset.cairnReady !== undefined')
  const readyMs = Number(await window.locator('html').getAttribute('data-cairn-ready'))
  expect(readyMs).toBeGreaterThan(0)

  const snapshot = (await app.evaluate(() => {
    const trace = (globalThis as { __cairnStartup?: { snapshot(): Snapshot } }).__cairnStartup
    return trace?.snapshot() ?? null
  })) as Snapshot | null
  expect(snapshot).not.toBeNull()
  expect(snapshot!.enabled).toBe(true)

  const marks = snapshot!.marks
  const at = (name: string) => marks.find((mark) => mark.name === name)?.at
  expect(marks.map((mark) => mark.name)).toEqual(
    expect.arrayContaining([
      'process_start',
      'lock_acquired',
      'startup_import_done',
      'paths_ready',
      'git_located',
      'storage_open',
      'services_ready',
      'when_ready',
      'window_created',
      'recovery_done',
      'did_finish_load',
      'window_shown',
    ]),
  )
  // 恢复在窗口创建之后、同一 tick 内完成，与首屏加载并行。
  expect(at('recovery_done')).toBeGreaterThanOrEqual(at('window_created')!)
  expect(at('window_shown')).toBeGreaterThanOrEqual(at('did_finish_load')!)
  expect(at('window_created')).toBeGreaterThan(at('when_ready')!)

  await testInfo.attach('startup-timing', {
    body: JSON.stringify({ readyMs, marks }, null, 2),
    contentType: 'application/json',
  })
})
