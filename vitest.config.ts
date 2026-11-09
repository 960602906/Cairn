import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Windows 上 Git 与 PowerShell 启动较慢，和全量测试并行时个别用例会超过默认 5 秒。
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.{ts,tsx}',
      'tooling/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.{ts,tsx}',
        'apps/*/src/**/*.{ts,tsx}',
        'scripts/**/*.js',
        'tooling/**/*.js',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Electron 进程入口只做启动引导，由冒烟测试（apps/desktop/scripts/smoke.js）覆盖
        'apps/desktop/src/main/index.ts',
        'apps/desktop/src/main/startup.ts',
        'apps/desktop/src/preload/index.ts',
        'apps/desktop/src/agent-host/index.ts',
        'apps/desktop/src/renderer/main.tsx',
      ],
      reporter: ['text-summary', 'text', 'html'],
      // 覆盖率门槛：四项均不低于 95%。
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
})
