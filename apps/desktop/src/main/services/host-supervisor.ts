/**
 * 宿主进程生命周期（M0-13c，ADR-0003，架构 §4、§21）。
 *
 * `startHost(init)`：启动宿主进程 → 协议握手 → `host.init`。成功后：
 * - 宿主发出的 `host.event` 交给存储服务分配 seq、落库、转发；其他会话的事件丢弃；
 * - 定期请求 `host.heartbeat`，超时视为卡死；
 * - 宿主意外退出或卡死时结束进程，写入 `session.crashed`（错误码 `host.exited` / `host.unresponsive`）。
 *
 * `host.init` 前按模型解析凭据（M1-03b，ADR-0010）与模型配置（M1-04b），只经 `host.init` 传给宿主；
 * 无法解析（系统加密不可用、无法解密、模型已从配置中删除）按启动失败处理，原因的错误码记入 `cause`。
 * 适用于会话的权限规则（M1-10c）同样在 `host.init` 前汇总并下发；检查点位置（M1-12b）与用户的自定义说明
 * （M1-13b）也是。
 *
 * 宿主的 `host.approval.request` 与 `host.approval.cancelled`（M1-11a）交给审批服务（M1-11b），会话与运行
 * 同样按这个宿主填入。宿主退出或崩溃时仍未决的审批一并取消；崩溃时补写 `approval.resolved`
 * （`cancelled`，由系统决定），之后再写 `session.crashed`。
 *
 * 宿主的 `changes.record`（M1-08b）交给改动服务，会话与运行按这个宿主填入，宿主不能写入其他会话的记录。
 *
 * 启动失败（进程无法创建、握手或初始化超时、协议不兼容）同样写入 `session.crashed`
 * （`host.start_failed`），并以 `RpcError` 拒绝。`stop()` 请求宿主正常退出，超时后强制结束，
 * 不写崩溃事件。
 *
 * 并发上限、空闲回收与退出清理由会话管理器（M0-13d）负责。
 */
import {
  createEndpoint,
  HostForMain,
  type AgentDefinition,
  type FileChangeInput,
  type HostApprovalRequest,
  type HostApprovalResponse,
  MainForHost,
  RpcError,
  type ErrorInfo,
  type HostModelConfig,
  type BackgroundCommand,
  type IsolatedWorkspaceInfo,
  type ModelRef,
  type PermissionRule,
  type PermissionMode,
  type RunAgentRef,
  type RunSnapshotInput,
  type SandboxCapability,
  type SandboxPolicy,
  type SandboxUnavailableBehavior,
  type ShellPreference,
  type SkillCatalogEntry,
  type McpToolExposure,
  type RequestOptions,
  type RpcEndpoint,
  type UnsequencedEvent,
} from '@cairn/protocol'
import { coveredSeqRange, type ResolvedCredential } from '@cairn/core'
import type { z } from 'zod'
import type { SessionEventService } from './event-service.js'
import type { HostProcess, SpawnHost } from './host-process.js'

export const HostErrorCode = {
  /** 宿主无法启动：进程创建失败、握手或初始化失败。 */
  StartFailed: 'host.start_failed',
  /** 宿主进程意外退出。 */
  Exited: 'host.exited',
  /** 心跳超时，宿主视为卡死并被结束。 */
  Unresponsive: 'host.unresponsive',
} as const

/** 会话管理器给出的初始化参数；凭据、模型配置、权限规则与检查点由监督器解析后加入。 */
export type HostInit = Omit<
  z.input<(typeof HostForMain)['requests']['host.init']['params']>,
  | 'credential'
  | 'modelConfig'
  | 'permissionRules'
  | 'checkpoints'
  | 'git'
  | 'instructions'
  | 'shell'
  | 'mcpTools'
  | 'agentDefinition'
  | 'sandbox'
>

/** 命令沙箱的初始化配置（M5-04）；由沙箱服务解析，随 `host.init` 下发。 */
export interface HostSandboxInit {
  readonly policy: SandboxPolicy
  readonly capability: SandboxCapability
  readonly unavailable: SandboxUnavailableBehavior
  readonly appContainerName?: string
}

/** 会话的检查点位置（M1-12b）：项目的影子仓库目录与会话的引用。 */
export interface HostCheckpointLocation {
  readonly gitDir: string
  readonly ref: string
}

/** 检查点使用的 Git（M5-03）：可执行文件与随包 MinGit 的受控环境变量。 */
export interface HostGit {
  readonly binary: string
  readonly env?: Readonly<Record<string, string>>
}

/** `host.delegate` 解析出的目标（M4-02）：凭据只留在宿主内存。 */
export interface HostDelegationTarget {
  readonly definition: AgentDefinition
  readonly model: ModelRef
  readonly credential?: { readonly apiKey: string }
  readonly modelConfig?: HostModelConfig
  readonly permissionRules: PermissionRule[]
  readonly skills: SkillCatalogEntry[]
  readonly mcpTools: McpToolExposure[]
  readonly workspace: 'shared' | 'isolated'
}

/** `delegate` 工具说明里列出的可委派目标（M4-02）。 */
export interface HostDelegateTargetInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly permissions: PermissionMode
}

export type HostState = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

export interface HostExit {
  readonly reason: 'stopped' | 'crashed'
  readonly error?: ErrorInfo
}

export interface HostHandle {
  readonly sessionId: string
  readonly runId: string
  readonly pid: number | undefined
  state(): HostState
  /** 转发用户输入（`message.user` 已由主进程落库）。 */
  prompt(params: z.input<(typeof HostForMain)['requests']['host.prompt']['params']>): Promise<void>
  abort(reason: 'user' | 'shutdown'): Promise<void>
  /** 重新汇总权限规则并交给宿主（`host.permissions.update`，M1-11b）：新增规则或切换模式之后调用。 */
  refreshPermissions(): Promise<void>
  /** 立刻压缩上下文（M3-03）。宿主空闲时马上做；轮次还在跑时排到它结束之后。 */
  compact(): Promise<boolean>
  /** 请求宿主正常退出；超时后强制结束。重复调用返回同一个 Promise。 */
  stop(): Promise<HostExit>
  /** 宿主结束（正常停止或崩溃）时 resolve。 */
  readonly exited: Promise<HostExit>
}

export interface HostSupervisorOptions {
  readonly spawn: SpawnHost
  readonly events: Pick<SessionEventService, 'publish'> &
    Partial<Pick<SessionEventService, 'readAfter'>>
  /**
   * 压缩时总结更早的对话（M3-03）。由主进程用会话模型调用。没有可用模型时返回 undefined，
   * 宿主改为丢掉最早的工具输出。
   */
  readonly summarize?: (sessionId: string, transcript: string) => Promise<string | undefined>
  /** 当前会话要点（M3-04）。没有要点时返回 undefined 或空字符串。 */
  readonly sessionBrief?: (sessionId: string) => string | undefined
  /** 按模型解析凭据（M1-03b）；没有保存凭据时返回 undefined。省略表示不传凭据。 */
  readonly resolveCredential?: (model: HostInit['model']) => Promise<ResolvedCredential | undefined>
  /**
   * 按模型给出宿主的模型配置（M1-04b）；没有时返回 undefined（宿主用 FakeRuntime 或开发用的
   * 环境变量）。会话自己的思考强度在这里覆盖模型配置里的默认值。抛出时按启动失败处理。省略表示不传。
   */
  readonly resolveModelConfig?: (
    model: HostInit['model'],
    sessionId: string,
  ) => HostModelConfig | undefined
  /**
   * 适用于会话的权限规则（M1-10c，权限服务）。抛出时按启动失败处理。省略时不传，宿主按“询问”模式
   * 的预设判定。
   */
  readonly resolvePermissionRules?: (sessionId: string, agent: RunAgentRef) => PermissionRule[]
  /** 用户的自定义说明（M1-13b，设置服务）；省略或返回 undefined 时不传。 */
  readonly resolveInstructions?: () => string | undefined
  /** 命令执行使用的 shell（M2-09，设置服务）；省略或返回 undefined 时不传（宿主按 `auto`）。 */
  readonly resolveShell?: () => ShellPreference | undefined
  /** 会话的检查点位置（M1-12b）；省略或返回 undefined 时宿主不创建检查点。 */
  readonly resolveCheckpoints?: (sessionId: string) => HostCheckpointLocation | undefined
  /** 检查点使用的 Git（M5-03）；省略时不传，宿主用 PATH 中的 `git`。 */
  readonly resolveGit?: () => HostGit | undefined
  /** 命令沙箱（M5-04）；省略时不传，宿主按平台不支持处理。 */
  readonly resolveSandbox?: () => Promise<HostSandboxInit | undefined> | HostSandboxInit | undefined
  /**
   * 记录宿主报告的文件改动（M1-08b，改动服务）。会话与运行由这个宿主确定。
   * 省略时宿主的 `changes.record` 报 `run.unsupported`。
   */
  readonly recordChange?: (
    sessionId: string,
    runId: string,
    input: FileChangeInput,
  ) => Promise<{ changeId: string }>
  /**
   * 转交宿主的审批请求（M1-11a，审批服务），等用户决定后返回。省略时报 `run.unsupported`，
   * 宿主按工具执行失败处理。
   */
  readonly requestApproval?: (
    sessionId: string,
    runId: string,
    request: HostApprovalRequest,
  ) => Promise<HostApprovalResponse>
  /** 宿主取消了未决审批（M1-11a）。 */
  readonly cancelApproval?: (sessionId: string, approvalId: string) => void
  /** 宿主上报一次模型调用前的上下文快照（M4-04）。 */
  readonly recordSnapshot?: (sessionId: string, snapshot: RunSnapshotInput) => void
  /** 握手与 `host.init` 的总时限，默认 10 秒。 */
  readonly startTimeoutMs?: number
  /** 心跳间隔，默认 5 秒。 */
  readonly heartbeatIntervalMs?: number
  /** 单次心跳的超时，默认 10 秒。 */
  readonly heartbeatTimeoutMs?: number
  /** `stop()` 等待宿主自行退出的时间，默认 3 秒。 */
  readonly shutdownTimeoutMs?: number
  readonly now?: () => number
  /** 记录异常：写崩溃事件失败、宿主发来其他会话的事件等。 */
  readonly onError?: (error: unknown) => void
  /**
   * 这一轮的项目说明（M3-02）。没有文件或项目关闭了读取时返回 undefined。
   * 省略时宿主每轮得到空结果，不读文件。
   */
  readonly loadAgentsMd?: (sessionId: string) =>
    | {
        readonly text: string
        readonly sha256: string
        readonly bytes: number
        readonly truncated: boolean
        readonly lines: number
      }
    | undefined
  /**
   * 这一轮交给模型的技能（M3-07）。省略或抛出时宿主这一轮不带技能。
   * 只应返回已启用、且没有被同名技能盖住的。
   */
  readonly loadSkills?: (sessionId: string, agent: RunAgentRef) => readonly SkillCatalogEntry[]
  /** 这一轮可用的 MCP 工具（M3-09）。省略表示没有。 */
  readonly resolveMcpTools?: (sessionId: string, agent: RunAgentRef) => readonly McpToolExposure[]
  /**
   * 运行引用的 Agent 定义（M3-11）：宿主据此决定指令、工具选择与上下文策略。省略时宿主按
   * 内置编程助手的行为运行（全部工具、没有额外指令）。
   */
  readonly resolveAgentDefinition?: (agent: RunAgentRef) => AgentDefinition | undefined
  /**
   * 解析一次委派的目标 Agent（M4-02）：已发布定义、模型、凭据、模型配置、权限规则、Skills、MCP 与
   * 工作区方式。返回 undefined 表示目标不存在或未发布。省略时宿主的 `delegate` 报 `run.unsupported`。
   */
  readonly resolveDelegation?: (
    sessionId: string,
    agentId: string,
  ) => HostDelegationTarget | undefined | Promise<HostDelegationTarget | undefined>
  /** 可委派目标的名称与描述（M4-02），用于 `delegate` 工具说明。省略时宿主只列 id。 */
  readonly resolveDelegateTargets?: (
    sessionId: string,
    agentIds: readonly string[],
  ) => readonly HostDelegateTargetInfo[]
  /**
   * 创建隔离工作区（M4-08）。省略时宿主的 `host.workspace.create` 报 `run.unsupported`，写入类委派
   * 回退到共享工作区。
   */
  readonly createIsolatedWorkspace?: (input: {
    readonly projectPath: string
    readonly baseCommit: string
    readonly sessionId: string
    readonly runId: string
    readonly gitDir?: string | undefined
  }) => Promise<IsolatedWorkspaceInfo>
  /** 清理隔离工作区（M4-08）。省略时返回 `cleaned: false`。 */
  readonly cleanupWorkspace?: (runId: string) => Promise<boolean>
  /**
   * 计算隔离工作区中的改动集（M4-09）。省略时宿主的 `host.changeset.create` 报 `run.unsupported`，
   * 子运行的改动不再可审阅。
   */
  readonly createChangeSet?: (
    sessionId: string,
    input: { readonly runId: string; readonly parentRunId?: string | undefined },
  ) => Promise<{
    changeSetId: string
    files: { path: string; added: number; removed: number }[]
  }>
  /** 启动后台命令（M4-14）：会话由连接确定，命令在主进程存活到停止或应用退出。 */
  readonly startCommand?: (
    sessionId: string,
    input: { runId: string; command: string; cwd: string; timeoutSeconds?: number },
  ) => Promise<BackgroundCommand>
  /** 执行宿主的 `host.mcp.call`（M3-09）。省略时报 `run.unsupported`。 */
  readonly callMcpTool?: (
    sessionId: string,
    serverId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    maxOutputTokens?: number,
  ) => Promise<{ text: string; isError: boolean }>
}

export interface HostSupervisor {
  startHost(init: HostInit): Promise<HostHandle>
}

type Timer = ReturnType<typeof setTimeout>

/** 主进程知道 seq，宿主不知道。压缩事件的被替换范围在落库前补上。 */
function compactionWithRange(
  events: HostSupervisorOptions['events'],
  sessionId: string,
  event: UnsequencedEvent,
): UnsequencedEvent {
  if (event.type !== 'context.compacted' || event.payload.replacedSeq !== undefined) return event
  const readAfter = events.readAfter
  if (!readAfter) return event
  const range = coveredSeqRange(readAfter(sessionId, 0), event.payload.coversTurns)
  if (!range) return event
  return { ...event, payload: { ...event.payload, replacedSeq: [range[0], range[1]] } }
}

export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000
  const now = options.now ?? Date.now

  return {
    async startHost(init) {
      const { sessionId, runId } = init

      const recordCrash = (error: ErrorInfo) => {
        try {
          options.events.publish([
            { v: 1, sessionId, runId, ts: now(), type: 'session.crashed', payload: { error } },
          ])
        } catch (e) {
          options.onError?.(e)
        }
      }

      let proc: HostProcess
      try {
        proc = options.spawn(sessionId)
      } catch (cause) {
        options.onError?.(cause)
        const error = { code: HostErrorCode.StartFailed }
        recordCrash(error)
        throw new RpcError(error.code)
      }

      let state: HostState = 'starting'
      let heartbeat: Timer | undefined
      let stopping: Promise<HostExit> | undefined
      let resolveExited!: (exit: HostExit) => void
      const exited = new Promise<HostExit>((resolve) => (resolveExited = resolve))

      const endpoint: RpcEndpoint<typeof MainForHost, typeof HostForMain> = createEndpoint(
        proc.channel,
        { local: MainForHost, remote: HostForMain },
      )

      /** 宿主请求、尚未结束的审批。 */
      const approvals = new Set<string>()
      /**
       * 先于请求到达的取消：宿主的事件立即发出，请求要等握手完成后才发出，请求刚发出就取消时
       * 取消可能先到。
       */
      const cancelledEarly = new Set<string>()

      const finish = (exit: HostExit) => {
        if (state === 'stopped' || state === 'crashed') return
        state = exit.reason
        if (heartbeat !== undefined) clearTimeout(heartbeat)
        endpoint.close()
        proc.kill()
        for (const approvalId of approvals) {
          options.cancelApproval?.(sessionId, approvalId)
          if (exit.error) {
            try {
              options.events.publish([
                {
                  v: 1,
                  sessionId,
                  runId,
                  ts: now(),
                  type: 'approval.resolved',
                  payload: { approvalId, decision: 'cancelled', decidedBy: 'system' },
                },
              ])
            } catch (e) {
              options.onError?.(e)
            }
          }
        }
        approvals.clear()
        cancelledEarly.clear()
        if (exit.error) recordCrash(exit.error)
        resolveExited(exit)
      }
      const crash = (code: string, params?: ErrorInfo['params']) =>
        finish({ reason: 'crashed', error: params ? { code, params } : { code } })

      proc.onExit((exitCode) => {
        if (state === 'stopping') finish({ reason: 'stopped' })
        else
          crash(state === 'starting' ? HostErrorCode.StartFailed : HostErrorCode.Exited, {
            exitCode,
          })
      })

      endpoint.handle('host.summarize', async ({ transcript }) => {
        const text = await options.summarize?.(sessionId, transcript)
        return text ? { text } : {}
      })

      endpoint.handle('host.sessionBrief', () => {
        const text = options.sessionBrief?.(sessionId)?.trim()
        return text ? { text } : {}
      })

      endpoint.handle('host.agentsMd', () => {
        const loaded = options.loadAgentsMd?.(sessionId)
        if (!loaded) return {}
        const { text, sha256, bytes, truncated, lines } = loaded
        return { text, context: { agentsMd: { sha256, bytes, truncated, lines } } }
      })

      endpoint.handle('host.skills', () => {
        try {
          return { skills: [...(options.loadSkills?.(sessionId, init.agent) ?? [])] }
        } catch (error) {
          options.onError?.(error)
          return { skills: [] }
        }
      })

      endpoint.handle('host.mcp.call', async ({ serverId, toolName, input, maxOutputTokens }) => {
        if (!options.callMcpTool) throw new RpcError('run.unsupported')
        return options.callMcpTool(sessionId, serverId, toolName, input, maxOutputTokens)
      })

      endpoint.handle('changes.record', (input) => {
        if (!options.recordChange) throw new RpcError('run.unsupported')
        return options.recordChange(sessionId, runId, input)
      })

      endpoint.handle('host.delegate', async ({ agent }) => {
        if (!options.resolveDelegation) throw new RpcError('run.unsupported')
        const target = await options.resolveDelegation(sessionId, agent)
        if (!target) throw new RpcError('delegation.agent_not_published', { agent })
        return target
      })

      endpoint.handle('host.delegate.targets', ({ agents }) => ({
        targets: [...(options.resolveDelegateTargets?.(sessionId, agents) ?? [])],
      }))

      endpoint.handle('host.workspace.create', async (input) => {
        if (!options.createIsolatedWorkspace) throw new RpcError('run.unsupported')
        return options.createIsolatedWorkspace(input)
      })

      endpoint.handle('host.workspace.cleanup', async ({ runId: childRunId }) => ({
        cleaned: (await options.cleanupWorkspace?.(childRunId)) ?? false,
      }))

      endpoint.handle('host.changeset.create', async (input) => {
        if (!options.createChangeSet) throw new RpcError('run.unsupported')
        return options.createChangeSet(sessionId, input)
      })

      endpoint.handle('host.command.start', async (input) => {
        if (!options.startCommand) throw new RpcError('run.unsupported')
        return options.startCommand(sessionId, {
          runId: input.runId,
          command: input.command,
          cwd: input.cwd,
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        })
      })

      endpoint.handle('host.snapshot', (snapshot) => {
        if (!options.recordSnapshot) throw new RpcError('run.unsupported')
        options.recordSnapshot(sessionId, snapshot)
        return {}
      })

      endpoint.handle('host.approval.request', async (request) => {
        if (!options.requestApproval) throw new RpcError('run.unsupported')
        if (cancelledEarly.delete(request.approvalId)) {
          throw new RpcError('approval.cancelled', { approvalId: request.approvalId })
        }
        approvals.add(request.approvalId)
        try {
          return await options.requestApproval(sessionId, runId, request)
        } finally {
          approvals.delete(request.approvalId)
        }
      })
      endpoint.on('host.approval.cancelled', ({ approvalId }) => {
        if (!approvals.delete(approvalId)) {
          cancelledEarly.add(approvalId)
          return
        }
        options.cancelApproval?.(sessionId, approvalId)
      })

      endpoint.on('host.event', ({ event }) => {
        if (state !== 'running' && state !== 'starting') return
        if (event.sessionId !== sessionId) {
          options.onError?.(
            new RpcError('rpc.invalid_params', { expected: sessionId, actual: event.sessionId }),
          )
          return
        }
        try {
          options.events.publish([compactionWithRange(options.events, sessionId, event)])
        } catch (e) {
          options.onError?.(e)
        }
      })

      const scheduleHeartbeat = () => {
        heartbeat = setTimeout(() => {
          heartbeat = undefined
          endpoint.request('host.heartbeat', {}, { timeoutMs: heartbeatTimeoutMs }).then(
            () => {
              if (state === 'running') scheduleHeartbeat()
            },
            () => {
              if (state === 'running') crash(HostErrorCode.Unresponsive)
            },
          )
        }, heartbeatIntervalMs)
      }

      // 握手与初始化在总时限内完成
      const started = (async () => {
        await endpoint.ready
        const modelConfig = options.resolveModelConfig?.(init.model, sessionId)
        const permissionRules = options.resolvePermissionRules?.(sessionId, init.agent)
        const checkpoints = options.resolveCheckpoints?.(sessionId)
        const git = options.resolveGit?.()
        const instructions = options.resolveInstructions?.()
        const shell = options.resolveShell?.()
        const sandbox = await options.resolveSandbox?.()
        const mcpTools = options.resolveMcpTools?.(sessionId, init.agent)
        const agentDefinition = options.resolveAgentDefinition?.(init.agent)
        const credential = await options.resolveCredential?.(init.model)
        await endpoint.request(
          'host.init',
          {
            ...init,
            ...(agentDefinition ? { agentDefinition } : {}),
            ...(credential ? { credential: { apiKey: credential.apiKey } } : {}),
            ...(modelConfig ? { modelConfig } : {}),
            ...(permissionRules ? { permissionRules } : {}),
            ...(checkpoints ? { checkpoints } : {}),
            ...(git ? { git: { binary: git.binary, ...(git.env ? { env: git.env } : {}) } } : {}),
            ...(instructions ? { instructions } : {}),
            ...(shell ? { shell } : {}),
            ...(sandbox ? { sandbox } : {}),
            ...(mcpTools && mcpTools.length > 0 ? { mcpTools: [...mcpTools] } : {}),
          },
          { timeoutMs: startTimeoutMs },
        )
      })()
      let startTimer: Timer | undefined
      const timedOut = new Promise<never>((_, reject) => {
        startTimer = setTimeout(
          () => reject(new RpcError('rpc.timeout', { timeoutMs: startTimeoutMs })),
          startTimeoutMs,
        )
      })
      const exitedEarly = exited.then(() => {
        throw new RpcError(HostErrorCode.Exited)
      })
      exitedEarly.catch(() => undefined)
      timedOut.catch(() => undefined)
      try {
        await Promise.race([started, timedOut, exitedEarly])
      } catch (cause) {
        options.onError?.(cause)
        const params: ErrorInfo['params'] =
          cause instanceof RpcError ? { cause: cause.code } : undefined
        if (state === 'starting') crash(HostErrorCode.StartFailed, params)
        started.catch(() => undefined)
        throw new RpcError(HostErrorCode.StartFailed)
      } finally {
        clearTimeout(startTimer)
      }

      state = 'running'
      scheduleHeartbeat()

      const call = async (
        method: 'host.prompt' | 'host.abort',
        params: object,
        o?: RequestOptions,
      ) => {
        await endpoint.request(method, params as never, o)
      }

      return {
        sessionId,
        runId,
        pid: proc.pid,
        state: () => state,
        prompt: (params) => call('host.prompt', params),
        abort: (reason) => call('host.abort', { reason }),
        compact: async () => {
          const result = await endpoint.request('host.compact', {}, { timeoutMs: 120_000 })
          return result.compacted
        },
        async refreshPermissions() {
          if (state !== 'running' || !options.resolvePermissionRules) return
          await endpoint.request('host.permissions.update', {
            rules: options.resolvePermissionRules(sessionId, init.agent),
          })
        },
        exited,
        stop() {
          if (stopping) return stopping
          if (state !== 'running') return (stopping = exited)
          state = 'stopping'
          if (heartbeat !== undefined) clearTimeout(heartbeat)
          const force = setTimeout(() => finish({ reason: 'stopped' }), shutdownTimeoutMs)
          endpoint
            .request('host.shutdown', {}, { timeoutMs: shutdownTimeoutMs })
            .catch(() => finish({ reason: 'stopped' }))
          stopping = exited.finally(() => clearTimeout(force))
          return stopping
        },
      }
    },
  }
}
