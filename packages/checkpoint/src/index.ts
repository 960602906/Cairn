/**
 * @cairn/checkpoint —— 影子 Git 仓库检查点（ADR-0008，架构 §11）：在应用数据目录中为每个项目维护
 * 一个影子仓库，创建工作区快照、预览与恢复，不触碰用户自己的 `.git`。
 */
export * from './git.js'
export * from './patterns.js'
export * from './shadow-repo.js'
