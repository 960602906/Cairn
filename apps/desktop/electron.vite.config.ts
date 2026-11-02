/**
 * electron-vite 构建配置（ADR-0002，架构 §4、§24）。
 *
 * 四个入口：
 * - `main`：主进程，`src/main/index.ts`；
 * - `agent-host`：agent 宿主（utilityProcess），`src/agent-host/index.ts`，与主进程同属 Node 环境，
 *   作为 main 构建的第二个入口输出到 `out/main/agent-host.js`；
 * - `preload`：`src/preload/index.ts`，在沙箱中运行，输出 CommonJS（`out/preload/index.cjs`）；
 * - `renderer`：React 界面，`src/renderer/index.html`。
 *
 * 工作区包（`@nexus/*`）以 TypeScript 源码导出，必须打进产物，不能作为外部依赖。
 */
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const root = import.meta.dirname
const workspacePackages = ['@nexus/protocol', '@nexus/core', '@nexus/storage', '@nexus/i18n']

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          'agent-host': resolve(root, 'src/agent-host/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        // 沙箱中的 preload 只支持 CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
})
