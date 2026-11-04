/**
 * @nexus/tools —— 内置工具实现（架构 §9.2）。只能经 `ToolContext` 访问工作区。
 * 依赖 @nexus/core 与 @nexus/protocol；不可引用 pi（ADR-0004）。
 */
import type { ToolRegistry } from '@nexus/core'
import { listDirTool } from './list-dir.js'
import { readFileTool } from './read-file.js'

export * from './paths.js'
export * from './read-file.js'
export * from './list-dir.js'

/** 注册读类内置工具（M1-07a）。 */
export function registerReadTools(registry: ToolRegistry): void {
  registry.register(readFileTool)
  registry.register(listDirTool)
}
