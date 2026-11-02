import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
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
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'text', 'html'],
      // 覆盖率门槛：四项均不低于 90%（docs/plan/m0.md §1.2）。
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
