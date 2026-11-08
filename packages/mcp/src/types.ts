/**
 * MCP 连接层的类型（M3-09，Runtime §21.3，ADR-0017）。
 * 这里只描述连接与工具调用，不依赖 Electron，也不依赖 @cairn/protocol。
 */

/** 本地进程：启动命令、参数、工作目录与环境变量。 */
export interface McpStdioTransport {
  readonly kind: 'stdio'
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** 已从凭据服务解析的环境变量。调用方不得把它写进日志或配置。 */
  readonly env?: Readonly<Record<string, string>>
}

/** 远程地址：Streamable HTTP，`headers` 已从凭据服务解析。 */
export interface McpHttpTransport {
  readonly kind: 'http'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export type McpTransport = McpStdioTransport | McpHttpTransport

export interface McpServerSpec {
  readonly serverId: string
  readonly name: string
  readonly transport: McpTransport
  /** 连接超时，默认 15 秒。 */
  readonly connectTimeoutMs?: number
  /** 单次工具调用超时，默认 60 秒。 */
  readonly callTimeoutMs?: number
  /** 每个服务保留的日志行数，默认 200。 */
  readonly maxLogLines?: number
}

export interface McpTool {
  readonly name: string
  readonly description: string
  /** 顶层 `type: "object"` 的 JSON Schema。 */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export type McpStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface McpServerState {
  readonly serverId: string
  readonly status: McpStatus
  readonly tools: readonly McpTool[]
  /** 最近一次失败的错误码与说明（已经脱敏）。 */
  readonly error?: { readonly code: string; readonly message: string }
}

export interface McpLogEntry {
  readonly ts: number
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

export interface McpCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface McpCallResult {
  /** 已转成文本的结果（图片、资源等会给出概括）。 */
  readonly text: string
  readonly isError: boolean
}

/** 供测试替换的 SDK 包装。 */
export interface McpClient {
  connect(): Promise<void>
  listTools(): Promise<readonly McpTool[]>
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options?: McpCallOptions,
  ): Promise<McpCallResult>
  close(): Promise<void>
  /** 服务端或传输层意外关闭时调用；主动 `close()` 不触发。 */
  onClose?(listener: () => void): void
  /** 子进程 stderr 等诊断输出；不得包含凭据。 */
  onLog?(listener: (line: string) => void): void
}

export type CreateMcpClient = (spec: McpServerSpec) => McpClient
