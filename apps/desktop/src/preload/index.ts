/**
 * preload 入口（ADR-0009，架构 §17）。在沙箱中运行，构建为 CommonJS。逻辑见 `expose.ts`。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { exposeRendererApi } from './expose.js'

exposeRendererApi({ contextBridge, ipcRenderer })
