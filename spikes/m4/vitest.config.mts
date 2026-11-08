import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * M4-00 预研用配置：直接运行工作区的 TypeScript 源码，不经过构建。
 * 这些测试不属于 `pnpm test` / 覆盖率门槛，由 `pnpm spike:m4` 单独运行。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      // 具体路径放在包名之前，避免被前缀匹配吃掉
      '@cairn/runtime-pi/testing': at('../../packages/runtime-pi/src/testing/mock-openai.ts'),
      '@cairn/protocol': at('../../packages/protocol/src/index.ts'),
      '@cairn/core': at('../../packages/core/src/index.ts'),
      '@cairn/checkpoint': at('../../packages/checkpoint/src/index.ts'),
      '@cairn/runtime-pi': at('../../packages/runtime-pi/src/index.ts'),
      '@cairn/shell': at('../../packages/shell/src/index.ts'),
      '@cairn/storage': at('../../packages/storage/src/index.ts'),
      '@cairn/tools': at('../../packages/tools/src/index.ts'),
      '@cairn/skills': at('../../packages/skills/src/index.ts'),
      '@cairn/mcp': at('../../packages/mcp/src/index.ts'),
      '@cairn/i18n': at('../../packages/i18n/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // 预研会创建真实的 Git 仓库与子进程，串行执行更容易读取测量数据
    fileParallelism: false,
  },
})
