/**
 * preload 入口（ADR-0009，架构 §17）。在沙箱中运行，构建为 CommonJS。
 *
 * M0-12a 只提供入口；基于 `createEndpoint` 的类型化 API 通过 `contextBridge` 暴露，在 M0-12b 实现。
 * 不得暴露 `ipcRenderer` 本身。
 */
export {}
