// @ts-check
/**
 * 把宿主（含 pi 及其依赖）打成 `dist/host.mjs`，对照"依赖从 node_modules 加载"（应用当前的方式）检查
 * pi 能否被打包。动态 import 保留为独立的 chunk。
 */
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/host.mjs',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'host.mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
  ssr: { noExternal: true, target: 'node' },
})
