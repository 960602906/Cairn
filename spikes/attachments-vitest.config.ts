import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) => fileURLToPath(new URL(`../packages/${name}`, import.meta.url))

// 只用于手动运行 spikes 下的真实模型验收（不进 CI、不参与覆盖率）。
export default defineConfig({
  resolve: {
    alias: {
      '@cairn/runtime-pi': pkg('runtime-pi'),
      '@cairn/protocol/runtime': `${pkg('protocol')}/src/runtime.ts`,
      '@cairn/protocol': pkg('protocol'),
      '@cairn/core': pkg('core'),
    },
  },
  test: {
    testTimeout: 240_000,
    include: ['spikes/attachments-real-model.test.ts'],
  },
})
