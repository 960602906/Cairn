/**
 * 已打包应用端到端测试（M5-02）。使用 Chromium CDP 而不是 Electron 主进程检查器，
 * 因为生产 fuses 已关闭 `--inspect` 与 `ELECTRON_RUN_AS_NODE`。
 */
import { defineConfig } from '@playwright/test'

const ci = Boolean(process.env['CI'])

export default defineConfig({
  testDir: '.',
  // 打包应用的用例：安装形态冒烟（M5-02）、发布验收全流程（M5-10）与沙箱写入（M5-10）。
  testMatch: [
    'packaged.spec.ts',
    'acceptance.spec.ts',
    'packaged-sandbox.spec.ts',
    'sandbox-path-probe.spec.ts',
  ],
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
