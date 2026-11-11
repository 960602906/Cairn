/**
 * MCP 连接管理器（M3-09，Runtime §21.3）：启动、连接、超时、断线重连、日志与工具调用。
 *
 * 连接放在主进程；宿主不直接连 MCP，经 `host.mcp.call` 请求主进程执行。管理器不保存凭据：
 * 传输配置里的环境变量与请求头由调用方从凭据服务解析后传入，日志按这些值脱敏。
 */
import { redactSecrets } from './redact.js'
import { createSdkClient } from './sdk-client.js'
import type {
  CreateMcpClient,
  McpCallOptions,
  McpCallResult,
  McpClient,
  McpLogEntry,
  McpServerSpec,
  McpServerState,
  McpStatus,
  McpTool,
} from './types.js'

export const McpErrorCode = {
  NotFound: 'mcp.not_found',
  NotConnected: 'mcp.not_connected',
  ConnectFailed: 'mcp.connect_failed',
  CallFailed: 'mcp.call_failed',
  Timeout: 'mcp.timeout',
} as const

export class McpError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'McpError'
  }
}

export interface McpReconnectPolicy {
  /** 连续尝试次数（含第一次）。默认 3。 */
  readonly attempts: number
  readonly initialDelayMs: number
  readonly factor: number
  readonly maxDelayMs: number
}

export const DEFAULT_RECONNECT_POLICY: McpReconnectPolicy = {
  attempts: 3,
  initialDelayMs: 500,
  factor: 2,
  maxDelayMs: 10_000,
}

export interface McpManagerOptions {
  readonly createClient?: CreateMcpClient
  readonly now?: () => number
  /** 测试注入；默认 `setTimeout`。 */
  readonly sleep?: (ms: number) => Promise<void>
  readonly reconnect?: McpReconnectPolicy
  readonly onStatus?: (state: McpServerState) => void
  readonly onLog?: (serverId: string, entry: McpLogEntry) => void
}

interface Entry {
  spec: McpServerSpec
  client?: McpClient | undefined
  status: McpStatus
  tools: McpTool[]
  error?: { code: string; message: string } | undefined
  logs: McpLogEntry[]
  closed: boolean
  reconnectTimer?: ReturnType<typeof setTimeout> | undefined
  reconnectAttempt: number
  secrets: string[]
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 不阻止进程退出
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })

function secretsOf(spec: McpServerSpec): string[] {
  const transport = spec.transport
  const values =
    transport.kind === 'stdio'
      ? Object.values(transport.env ?? {})
      : Object.values(transport.headers ?? {})
  return values.filter((value) => value.length >= 4)
}

export class McpManager {
  private readonly entries = new Map<string, Entry>()
  private readonly createClient: CreateMcpClient
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly policy: McpReconnectPolicy

  constructor(private readonly options: McpManagerOptions = {}) {
    this.createClient = options.createClient ?? createSdkClient
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
    this.policy = options.reconnect ?? DEFAULT_RECONNECT_POLICY
  }

  /** 注册并立即连接（等待第一次尝试的结果）。重复的 serverId 会替换旧配置。 */
  async add(spec: McpServerSpec): Promise<McpServerState> {
    const existing = this.entries.get(spec.serverId)
    if (existing) await this.closeEntry(existing)
    const entry: Entry = {
      spec,
      status: 'disconnected',
      tools: [],
      logs: [],
      closed: false,
      reconnectAttempt: 0,
      secrets: secretsOf(spec),
    }
    this.entries.set(spec.serverId, entry)
    await this.connectWithRetry(entry, true)
    return this.stateOf(entry)
  }

  remove(serverId: string): void {
    const entry = this.entries.get(serverId)
    if (!entry) return
    this.entries.delete(serverId)
    void this.closeEntry(entry)
  }

  /** 手动重连：重置重试计数，从头开始。 */
  async reconnect(serverId: string): Promise<McpServerState> {
    const entry = this.require(serverId)
    this.cancelReconnect(entry)
    if (entry.client) {
      try {
        await entry.client.close()
      } catch {
        // 已断开的连接关闭失败不影响重连
      }
      entry.client = undefined
    }
    entry.closed = false
    await this.connectWithRetry(entry, true)
    return this.stateOf(entry)
  }

  list(): McpServerState[] {
    return [...this.entries.values()].map((entry) => this.stateOf(entry))
  }

  get(serverId: string): McpServerState | undefined {
    const entry = this.entries.get(serverId)
    return entry === undefined ? undefined : this.stateOf(entry)
  }

  logs(serverId: string): readonly McpLogEntry[] {
    return this.require(serverId).logs
  }

  tools(): { serverId: string; tool: McpTool }[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.status === 'connected'
        ? entry.tools.map((tool) => ({ serverId: entry.spec.serverId, tool }))
        : [],
    )
  }

  async call(
    serverId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: McpCallOptions = {},
  ): Promise<McpCallResult> {
    const entry = this.require(serverId)
    if (entry.status !== 'connected' || !entry.client) {
      throw new McpError(McpErrorCode.NotConnected, `MCP server is not connected: ${serverId}`)
    }
    try {
      return await entry.client.callTool(toolName, input, options)
    } catch (error) {
      const message = this.redact(entry, error instanceof Error ? error.message : String(error))
      this.log(entry, 'error', `call ${toolName} failed: ${message}`)
      throw error instanceof McpError ? error : new McpError(McpErrorCode.CallFailed, message)
    }
  }

  async close(): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map((entry) => this.closeEntry(entry)))
  }

  private require(serverId: string): Entry {
    const entry = this.entries.get(serverId)
    if (!entry) throw new McpError(McpErrorCode.NotFound, `unknown MCP server: ${serverId}`)
    return entry
  }

  private stateOf(entry: Entry): McpServerState {
    return {
      serverId: entry.spec.serverId,
      status: entry.status,
      tools: [...entry.tools],
      ...(entry.error ? { error: entry.error } : {}),
    }
  }

  private emitStatus(entry: Entry): void {
    this.options.onStatus?.(this.stateOf(entry))
  }

  private log(entry: Entry, level: McpLogEntry['level'], message: string): void {
    const entryLog: McpLogEntry = {
      ts: this.now(),
      level,
      message: this.redact(entry, message),
    }
    entry.logs.push(entryLog)
    const max = entry.spec.maxLogLines ?? 200
    if (entry.logs.length > max) entry.logs.splice(0, entry.logs.length - max)
    this.options.onLog?.(entry.spec.serverId, entryLog)
  }

  private redact(entry: Entry, message: string): string {
    return redactSecrets(message, entry.secrets)
  }

  private setStatus(
    entry: Entry,
    status: McpStatus,
    error?: { code: string; message: string },
  ): void {
    entry.status = status
    entry.error = error
    this.emitStatus(entry)
  }

  private async connectWithRetry(entry: Entry, reportFailure: boolean): Promise<void> {
    const { attempts, initialDelayMs, factor, maxDelayMs } = this.policy
    this.setStatus(entry, 'connecting')
    this.log(entry, 'info', `connecting to ${entry.spec.name}`)
    let delay = initialDelayMs
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (entry.closed) return
      try {
        await this.connectOnce(entry)
        entry.reconnectAttempt = 0
        this.setStatus(entry, 'connected')
        this.log(entry, 'info', `connected to ${entry.spec.name} (${entry.tools.length} tools)`)
        return
      } catch (error) {
        if (entry.closed) return
        const message = this.redact(entry, error instanceof Error ? error.message : String(error))
        const timeout = error instanceof McpError && error.code === McpErrorCode.Timeout
        if (attempt >= attempts) {
          this.log(entry, 'error', `connect failed: ${message}`)
          if (reportFailure) {
            this.setStatus(entry, 'error', {
              code: timeout ? McpErrorCode.Timeout : McpErrorCode.ConnectFailed,
              message,
            })
          } else {
            entry.reconnectAttempt += 1
            this.scheduleReconnect(entry)
          }
          return
        }
        this.log(entry, 'warn', `connect attempt ${attempt} failed: ${message}; retrying`)
        await this.sleep(delay)
        delay = Math.min(delay * factor, maxDelayMs)
      }
    }
  }

  private async connectOnce(entry: Entry): Promise<void> {
    const client = this.createClient(entry.spec)
    entry.client = client
    client.onClose?.(() => {
      if (entry.closed || entry.client !== client) return
      entry.client = undefined
      entry.tools = []
      this.setStatus(entry, 'disconnected')
      this.log(entry, 'warn', `connection to ${entry.spec.name} closed; reconnecting`)
      this.scheduleReconnect(entry)
    })
    client.onLog?.((line) => {
      for (const part of line.split(/\r?\n/)) {
        if (part.trim()) this.log(entry, 'info', `stderr: ${part.trim()}`)
      }
    })
    const timeoutMs = entry.spec.connectTimeoutMs ?? 15_000
    try {
      await withTimeout(client.connect(), timeoutMs, McpErrorCode.Timeout)
      entry.tools = [...(await withTimeout(client.listTools(), timeoutMs, McpErrorCode.Timeout))]
    } catch (error) {
      // 失败或超时的连接要关掉，不然每次重试都多留一个子进程
      if (entry.client === client) entry.client = undefined
      entry.tools = []
      await client.close().catch(() => undefined)
      throw error
    }
    if (entry.closed || entry.client !== client) {
      // 连接期间服务被删除、停用或替换：这个连接不再用
      if (entry.client === client) entry.client = undefined
      entry.tools = []
      await client.close().catch(() => undefined)
      throw new McpError(McpErrorCode.ConnectFailed, 'server was removed while connecting')
    }
  }

  private scheduleReconnect(entry: Entry, delay?: number): void {
    if (entry.closed) return
    this.cancelReconnect(entry)
    const { attempts, initialDelayMs, factor, maxDelayMs } = this.policy
    const attempt = entry.reconnectAttempt + 1
    const wait = delay ?? Math.min(initialDelayMs * factor ** (attempt - 1), maxDelayMs)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined
      if (entry.closed) return
      if (attempt > attempts) {
        this.setStatus(entry, 'error', {
          code: McpErrorCode.ConnectFailed,
          message: 'reconnect attempts exhausted',
        })
        return
      }
      entry.reconnectAttempt = attempt
      void this.connectWithRetry(entry, false)
    }, wait)
    entry.reconnectTimer.unref?.()
  }

  private cancelReconnect(entry: Entry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = undefined
    }
  }

  private async closeEntry(entry: Entry): Promise<void> {
    entry.closed = true
    this.cancelReconnect(entry)
    const client = entry.client
    entry.client = undefined
    entry.tools = []
    await client?.close().catch(() => undefined)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpError(code, `timed out after ${ms} ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
