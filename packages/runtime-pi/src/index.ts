/**
 * @nexus/runtime-pi —— 基于 pi（pi-agent-core、pi-ai）实现 `AgentRuntime`（ADR-0004、ADR-0021）。
 * 这是唯一可以引用 `@earendil-works/*` 的包（ESLint 依赖边界规则）。
 * 包骨架与版本守卫见 M1-01a；消息转换、会话与事件映射、接入宿主在 M1-01b～d 实现。
 */

/**
 * 锁定的 pi 版本。pi 各包（pi-agent-core、pi-ai 及其依赖的 pi-*）必须是同一个精确版本，
 * 由 `pi-version.test.ts` 检查 package.json、锁文件与实际安装都与这里一致（S8）。
 * 升级 pi 时同时修改这里、package.json 与契约测试的录制。
 */
export const PI_VERSION = '1.5.0'
