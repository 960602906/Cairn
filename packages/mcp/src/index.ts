/**
 * @cairn/mcp —— MCP 连接管理与 SDK 适配（M3-09，Runtime §21.3，ADR-0017）。
 * 不依赖 Electron；凭据由调用方解析后传入，不在这里保存。
 */
export {
  DEFAULT_RECONNECT_POLICY,
  McpError,
  McpErrorCode,
  McpManager,
  type McpManagerOptions,
  type McpReconnectPolicy,
} from './manager.js'
export { redactSecrets } from './redact.js'
export { contentToText, createSdkClient, stdioCommand } from './sdk-client.js'
export type {
  CreateMcpClient,
  McpCallOptions,
  McpCallResult,
  McpClient,
  McpHttpTransport,
  McpLogEntry,
  McpServerSpec,
  McpServerState,
  McpStatus,
  McpStdioTransport,
  McpTool,
  McpTransport,
} from './types.js'
