/**
 * MCP 服务（M3-09，Runtime §21.3，ADR-0017、ADR-0026）。
 *
 * - 配置存 `mcp_servers`；环境变量值与令牌只存凭据服务，配置里只有引用。
 * - 应用启动时连接已启用的服务；状态变化推给界面。
 * - 每个工具适配成 `ToolDefinition` 的定义（`McpToolExposure`）交给宿主；宿主调用时经
 *   `host.mcp.call` 回到这里执行，不让宿主直接连 MCP。
 * - 每个服务保留最近 200 行日志，日志按凭据值脱敏（管理器负责）。
 */
import { randomUUID } from 'node:crypto'
import {
  McpManager,
  McpError,
  McpErrorCode,
  type McpServerSpec,
  type McpServerState,
} from '@cairn/mcp'
import {
  RpcError,
  type McpLogEntry,
  type McpServerDetail,
  type McpServerInput,
  type McpServerSummary,
  type McpStatusEvent,
  type McpToolExposure,
  type McpToolSummary,
  type PermissionEffect,
  type ToolCategory,
} from '@cairn/protocol'
import type { McpEnvRef, McpServerRecord, Storage } from '@cairn/storage'

export const McpServiceErrorCode = {
  NotFound: 'mcp.not_found',
  ToolNotFound: 'mcp.tool_not_found',
  NotConnected: 'mcp.not_connected',
  CallFailed: 'mcp.call_failed',
  Invalid: 'mcp.invalid',
} as const

export interface McpCredentialStore {
  set(ref: string, secret: string): Promise<void>
  delete(ref: string): Promise<boolean>
  resolve(ref: string): Promise<{ readonly apiKey: string } | undefined>
  has(ref: string): boolean
}

export interface McpServiceOptions {
  readonly storage: Pick<Storage, 'mcpServers' | 'mcpToolPrefs'>
  readonly credentials: McpCredentialStore
  readonly createId?: () => string
  readonly manager?: McpManager
  /** 状态变化时调用；服务把它推给界面。 */
  readonly onStatus?: (event: McpStatusEvent) => void
  readonly onError?: (error: unknown) => void
}

export interface McpCommands {
  list(input: Record<string, never>): { servers: McpServerSummary[] }
  get(input: { serverId: string }): McpServerDetail
  add(input: McpServerInput): Promise<McpServerDetail>
  update(input: { serverId: string; server: McpServerInput }): Promise<McpServerDetail>
  remove(input: { serverId: string }): Record<string, never>
  reconnect(input: { serverId: string }): Promise<McpServerSummary>
  setEnabled(input: { serverId: string; enabled: boolean }): Promise<McpServerSummary>
  tools(input: { serverId: string }): { tools: McpToolSummary[] }
  setTool(input: {
    serverId: string
    name: string
    category?: ToolCategory | undefined
    effect?: PermissionEffect | undefined
  }): McpToolSummary
  logs(input: { serverId: string }): { logs: McpLogEntry[] }
}

export interface McpService extends McpCommands {
  /** 连接所有已启用的服务（应用启动时调用一次）。 */
  initialize(): Promise<void>
  /** 这一轮交给宿主的工具定义。 */
  exposures(): McpToolExposure[]
  call(
    serverId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    maxOutputTokens?: number,
  ): Promise<{ text: string; isError: boolean }>
  close(): Promise<void>
}

const envRef = (serverId: string, name: string, used: Set<string>): string => {
  const base = `mcp-${serverId}-env-${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)}`
  let ref = base
  let index = 2
  while (used.has(ref)) {
    ref = `${base.slice(0, 100)}-${index}`
    index += 1
  }
  used.add(ref)
  return ref
}

const toolToken = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool'

/** 工具名最长 64：服务名与工具名都截断，冲突时加序号。 */
function uniqueToolName(server: string, tool: string, used: Set<string>): string {
  const base = `mcp_${toolToken(server)}_${toolToken(tool)}`.slice(0, 64)
  let name = base
  let index = 2
  while (used.has(name)) {
    const suffix = `_${index}`
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`
    index += 1
  }
  used.add(name)
  return name
}

export function createMcpService(options: McpServiceOptions): McpService {
  const { storage, credentials } = options
  const createId = options.createId ?? randomUUID
  const manager =
    options.manager ??
    new McpManager({
      onStatus: (state) => emitStatus(state),
    })

  function emitStatus(state: McpServerState): void {
    options.onStatus?.({
      serverId: state.serverId,
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
      toolCount: state.status === 'connected' ? state.tools.length : 0,
    })
  }

  const requireRecord = (serverId: string): McpServerRecord => {
    const record = storage.mcpServers.get(serverId)
    if (!record) throw new RpcError(McpServiceErrorCode.NotFound, { serverId })
    return record
  }

  const summaryOf = (record: McpServerRecord): McpServerSummary => {
    const state = manager.get(record.serverId)
    const status = !record.enabled ? 'disabled' : (state?.status ?? 'disconnected')
    return {
      serverId: record.serverId,
      name: record.name,
      kind: record.kind,
      enabled: record.enabled,
      status,
      ...(state?.error ? { error: state.error } : {}),
      toolCount: status === 'connected' ? (state?.tools.length ?? 0) : 0,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * 按存储顺序为所有已连接服务的工具分配全局唯一名称。
   * 每个服务单独计算会互相占用名称，导致同一个工具在不同页面显示不同的名字。
   */
  const toolNames = (): Map<string, Map<string, string>> => {
    const used = new Set<string>()
    const result = new Map<string, Map<string, string>>()
    for (const item of storage.mcpServers.list()) {
      if (!item.enabled) continue
      const state = manager.get(item.serverId)
      if (state?.status !== 'connected') continue
      const names = new Map<string, string>()
      for (const tool of state.tools) {
        names.set(tool.name, uniqueToolName(item.name, tool.name, used))
      }
      result.set(item.serverId, names)
    }
    return result
  }

  const toolSummaries = (record: McpServerRecord): McpToolSummary[] => {
    const state = manager.get(record.serverId)
    if (!record.enabled || !state || state.status !== 'connected') return []
    const names = toolNames().get(record.serverId)!
    return state.tools.map((tool) => {
      const pref = storage.mcpToolPrefs.get(record.serverId, tool.name)
      return {
        name: names.get(tool.name)!,
        originalName: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema },
        category: pref?.category ?? 'network',
        effect: pref?.effect ?? 'ask',
      }
    })
  }

  const detailOf = (record: McpServerRecord): McpServerDetail => {
    const env = record.env.map((entry) => ({
      name: entry.name,
      configured: credentials.has(entry.credentialRef),
    }))
    return {
      ...summaryOf(record),
      ...(record.command === undefined ? {} : { command: record.command }),
      ...(record.args.length === 0 ? {} : { args: [...record.args] }),
      ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      env,
      ...(record.url === undefined ? {} : { url: record.url }),
      auth: record.auth,
      ...(record.headerName === undefined ? {} : { headerName: record.headerName }),
      tokenConfigured:
        record.auth !== 'none' &&
        record.credentialRef !== undefined &&
        credentials.has(record.credentialRef),
      tools: toolSummaries(record),
    }
  }

  const specOf = async (record: McpServerRecord): Promise<McpServerSpec> => {
    if (record.kind === 'stdio') {
      const env: Record<string, string> = {}
      for (const entry of record.env) {
        const value = await credentials.resolve(entry.credentialRef)
        if (value) env[entry.name] = value.apiKey
      }
      return {
        serverId: record.serverId,
        name: record.name,
        transport: {
          kind: 'stdio',
          command: record.command ?? '',
          ...(record.args.length > 0 ? { args: [...record.args] } : {}),
          ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
      }
    }
    const headers: Record<string, string> = {}
    if (record.auth !== 'none' && record.credentialRef) {
      const token = await credentials.resolve(record.credentialRef)
      if (token) {
        if (record.auth === 'bearer') headers['Authorization'] = `Bearer ${token.apiKey}`
        else headers[record.headerName ?? 'Authorization'] = token.apiKey
      }
    }
    return {
      serverId: record.serverId,
      name: record.name,
      transport: {
        kind: 'http',
        url: record.url ?? '',
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    }
  }

  const applyUpdate = async (serverId: string, input: McpServerInput): Promise<McpServerRecord> => {
    const current = requireRecord(serverId)
    const used = new Set(current.env.map((entry) => entry.credentialRef))
    const existing = new Map(current.env.map((entry) => [entry.name, entry.credentialRef]))
    let env: readonly McpEnvRef[] = current.env
    if (input.env !== undefined) {
      const next: McpEnvRef[] = []
      for (const entry of input.env) {
        const ref = existing.get(entry.name) ?? envRef(serverId, entry.name, used)
        if (entry.value !== undefined) await credentials.set(ref, entry.value)
        next.push({ name: entry.name, credentialRef: ref })
      }
      for (const entry of current.env) {
        if (!next.some((item) => item.credentialRef === entry.credentialRef)) {
          await credentials.delete(entry.credentialRef)
        }
      }
      env = next
    }

    let credentialRef = current.credentialRef
    if (input.token !== undefined) {
      credentialRef ??= `mcp-${serverId}-token`
      await credentials.set(credentialRef, input.token)
    } else if (input.clearToken && credentialRef) {
      await credentials.delete(credentialRef)
      credentialRef = undefined
    }

    const stdio = input.kind === 'stdio'
    const record = storage.mcpServers.update(serverId, {
      name: input.name,
      kind: input.kind,
      command: stdio ? (input.command ?? current.command ?? '') : null,
      args: stdio ? (input.args ?? []) : [],
      cwd: stdio ? (input.cwd ?? null) : null,
      url: stdio ? null : (input.url ?? current.url ?? ''),
      auth: input.auth ?? current.auth,
      headerName: input.headerName ?? null,
      credentialRef: credentialRef ?? null,
      env,
      enabled: input.enabled ?? current.enabled,
    })
    manager.remove(serverId)
    if (record.enabled) {
      const spec = await specOf(record)
      await manager.add(spec)
    }
    return record
  }

  return {
    async initialize() {
      for (const record of storage.mcpServers.list()) {
        if (!record.enabled) continue
        try {
          const spec = await specOf(record)
          void manager.add(spec).catch(options.onError)
        } catch (error) {
          options.onError?.(error)
        }
      }
    },

    list: () => ({ servers: storage.mcpServers.list().map(summaryOf) }),
    get: ({ serverId }) => detailOf(requireRecord(serverId)),

    async add(input) {
      const serverId = createId()
      storage.mcpServers.create({
        serverId,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled ?? true,
      })
      return detailOf(await applyUpdate(serverId, input))
    },

    async update({ serverId, server }) {
      return detailOf(await applyUpdate(serverId, server))
    },

    remove({ serverId }) {
      const record = requireRecord(serverId)
      manager.remove(serverId)
      storage.mcpServers.remove(serverId)
      for (const entry of record.env) void credentials.delete(entry.credentialRef)
      if (record.credentialRef) void credentials.delete(record.credentialRef)
      return {}
    },

    async reconnect({ serverId }) {
      const record = requireRecord(serverId)
      if (!record.enabled) throw new RpcError(McpServiceErrorCode.Invalid, { reason: 'disabled' })
      const spec = await specOf(record)
      await manager.add(spec)
      return summaryOf(record)
    },

    async setEnabled({ serverId, enabled }) {
      const record = storage.mcpServers.update(serverId, { enabled })
      manager.remove(serverId)
      if (enabled) await manager.add(await specOf(record))
      options.onStatus?.({
        serverId,
        status: enabled ? 'disconnected' : 'disabled',
        toolCount: 0,
      })
      return summaryOf(record)
    },

    tools({ serverId }) {
      return { tools: toolSummaries(requireRecord(serverId)) }
    },

    setTool({ serverId, name, category, effect }) {
      const record = requireRecord(serverId)
      const summary = toolSummaries(record).find((tool) => tool.name === name)
      if (!summary) throw new RpcError(McpServiceErrorCode.ToolNotFound, { serverId, name })
      const pref = storage.mcpToolPrefs.set({
        serverId,
        name: summary.originalName,
        category: category ?? summary.category,
        effect: effect ?? summary.effect,
      })
      return {
        ...summary,
        category: pref.category,
        effect: pref.effect,
      }
    },

    logs({ serverId }) {
      requireRecord(serverId)
      return { logs: [...manager.logs(serverId)] }
    },

    exposures() {
      const names = toolNames()
      const result: McpToolExposure[] = []
      for (const record of storage.mcpServers.list()) {
        if (!record.enabled) continue
        const state = manager.get(record.serverId)
        if (state?.status !== 'connected') continue
        const serverNames = names.get(record.serverId)!
        for (const tool of state.tools) {
          const pref = storage.mcpToolPrefs.get(record.serverId, tool.name)
          result.push({
            name: serverNames.get(tool.name)!,
            description: tool.description,
            inputSchema: { ...tool.inputSchema },
            serverId: record.serverId,
            originalName: tool.name,
            category: pref?.category ?? 'network',
          })
        }
      }
      return result
    },

    async call(serverId, toolName, input, maxOutputTokens = 4_000) {
      try {
        const result = await manager.call(serverId, toolName, input)
        const maxChars = Math.max(1_000, maxOutputTokens * 4)
        const text =
          result.text.length <= maxChars
            ? result.text
            : `${result.text.slice(0, Math.floor(maxChars * 0.6))}\n\n[Output truncated]\n\n${result.text.slice(-Math.floor(maxChars * 0.3))}`
        return { text, isError: result.isError }
      } catch (error) {
        if (error instanceof McpError) {
          throw new RpcError(
            error.code === McpErrorCode.NotConnected
              ? McpServiceErrorCode.NotConnected
              : McpServiceErrorCode.CallFailed,
          )
        }
        options.onError?.(error)
        throw new RpcError(McpServiceErrorCode.CallFailed)
      }
    },

    close: () => manager.close(),
  }
}
