// @ts-check
/**
 * 发布工具：Windows 与 macOS 的签名配置、产物校验与发布参数。由根 `scripts/` 与
 * `apps/desktop/scripts/` 共用；只依赖 Node 内置模块，不进入应用运行时。
 */
export * from './signing.mjs'
export * from './mac-signing.mjs'
