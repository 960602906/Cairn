/**
 * 已打包应用端到端测试（M5-02）。使用 Chromium CDP 而不是 Electron 主进程检查器，
 * 因为生产 fuses 已关闭 `--inspect` 与 `ELECTRON_RUN_AS_NODE`。
 */
import { defineConfig } from '@playwright/test'

const ci = Boolean(process.env['CI'])

export default defineConfig({
  testDir: '.',
  testMatch: 'packaged.spec.ts',
  outputDir: '../test-results-packaged',
  globalSetup: './packaged-global-setup.ts',
  workers: 1,
  retries: 0,
  forbidOnly: ci,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: ci
    ? [['list'], ['html', { outputFolder: '../playwright-report-packaged', open: 'never' }]]
    : [['list']],
  use: { trace: 'retain-on-failure' },
})
