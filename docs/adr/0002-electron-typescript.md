# ADR-0002 使用 Electron 与全栈 TypeScript

- 状态：已接受
- 日期：2026-11-02

## 背景

需要一个跨平台桌面应用，首发 Windows，后续支持 macOS 和 Linux。开发者有前端经验，没有 Rust 经验。agent 核心选用的 pi 是 TypeScript 库，需要 Node 运行时。

## 决定

- 桌面外壳使用 Electron，构建工具 electron-vite，打包工具 electron-builder。
- 界面使用 React + TypeScript，组件基于 Tailwind CSS 与 shadcn/ui，代码与 diff 使用 Monaco Editor，状态管理使用 Zustand。
- 全部代码使用 TypeScript（严格模式）。

## 备选方案

- **Tauri**：体积小、内存低，但后端需写 Rust；pi 仍需 Node 运行时，要额外打包 Node 作为 sidecar，复杂度更高。
- **原生（WPF、SwiftUI 等）**：每个平台单独开发，成本过高。

## 后果

- 安装包体积较大（通常上百 MB），内存占用高于原生应用，可接受。
- 可以直接在 Node 环境中运行 pi，前后端共享类型定义。
- 需要关注 Electron 的安全配置（见架构文档第 17 节）和原生模块的重新编译。
