/**
 * 端到端测试（M0-16，架构 §23、§26）：Playwright 启动构建产物（需先 `pnpm build`）。
 *
 * 不重试：验收要求在 Windows CI 上连续稳定通过，重试会掩盖偶发失败。每个用例启动独立的应用实例与
 * 数据目录，串行执行，避免多个 Electron 实例互相争抢资源导致的不稳定。
 */
import { defineConfig } from '@playwright/test'

const ci = Boolean(process.env['CI'])

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // 打包应用 e2e 需要先 `pnpm package:dir`，由 packaged.config.ts 单独运行（M5-02、M5-10）。
  testIgnore: ['packaged.spec.ts', 'acceptance.spec.ts'],
  outputDir: '../test-results',
  globalSetup: './global-setup.ts',
  workers: 1,
  retries: 0,
  forbidOnly: ci,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]]
    : [['list']],
  use: { trace: 'retain-on-failure' },
})
