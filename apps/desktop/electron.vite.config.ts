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
 * pi（`@earendil-works/*`）只是 runtime-pi 的依赖，不在本包的 dependencies 中，因此同样打进宿主产物（S1：
 * 依赖外置时 app.asar 几乎全是 node_modules，打包后宿主加载更快）。各接口格式的实现是按需加载的独立分块。
 * koffi（@nexus/shell 的 Job Object，M1-09b）相反，列在本包的 dependencies 中、不打进产物：它按自身所在位置
 * 查找各平台的预编译二进制（`@koromix/koffi-<平台>`），打包时（M5）需列入 asarUnpack。
 */
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { buildContentSecurityPolicy } from './src/main/security.js'

const root = import.meta.dirname
const workspacePackages = [
  '@nexus/protocol',
  '@nexus/core',
  '@nexus/storage',
  '@nexus/i18n',
  '@nexus/runtime-pi',
  '@nexus/tools',
  '@nexus/shell',
]

/** 把 CSP 以 `<meta>` 写入界面 HTML（`file:` 加载时没有响应头）。开发服务器使用放宽的版本。 */
function contentSecurityPolicy(): Plugin {
  let dev = false
  return {
    name: 'nexus-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: buildContentSecurityPolicy({ dev }),
          },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

/**
 * 把当前平台的 ripgrep（`@vscode/ripgrep` 的平台包）复制到 `out/bin/`，供 `search` 工具使用（M1-07b）。
 * 安装包打包时（M5）需把 `out/bin/` 列入 asarUnpack；许可证见 THIRD_PARTY_NOTICES。
 */
function bundleRipgrep(): Plugin {
  return {
    name: 'nexus-ripgrep',
    apply: 'build',
    closeBundle() {
      const dir = resolve(root, 'out/bin')
      const target = resolve(dir, basename(rgPath))
      mkdirSync(dir, { recursive: true })
      copyFileSync(rgPath, target)
      chmodSync(target, 0o755)
    },
  }
}

export default defineConfig({
  main: {
    plugins: [bundleRipgrep()],
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
      // 沙箱中的 preload 不能 require 第三方模块，所有依赖（含 zod）都必须打进产物
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        // 沙箱中的 preload 只支持 CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [contentSecurityPolicy(), react()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
})
