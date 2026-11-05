/**
 * agent 宿主（M0-14，ADR-0003、ADR-0004，架构 §8.4，Runtime §13）：主进程 `HostForMain` 接口的实现。
 *
 * - `host.init`：用注入的运行时创建 `RunSupervisor` 与运行；带 `resume` 时恢复已有运行（以历史
 *   重建运行时会话，不发出 `run.created`；记录的运行中状态按中断处理）。
 * - `host.prompt`：交给运行排队执行，立即返回；一轮的结果以事件回传。
 * - `host.abort`：中止当前轮次（发出 `turn.aborted`）。
 * - `host.shutdown`：中止进行中的轮次（`turn.aborted`，原因 `shutdown`），回复后退出进程。
 *   运行不释放：下次启动宿主时由主进程以 `resume` 继续同一个运行。
 * - `host.heartbeat`：回复当前时间。
 * 运行发出的事件以 `host.event` 原样转发，seq 由主进程分配。
 *
 * 工具（M1-11a）：`host.init` 时由 `registerTools` 注册内置工具，交给工具流水线执行（Runtime §7）：
 * - 权限：`permissions` 按 `host.init` 下发的规则（省略时为“询问”模式的预设）与强制拦截判定；
 *   `host.permissions.update` 替换规则，审批时“始终允许”生成的规则立即加入；
 * - 审批：经 `host.approval.request` 请主进程转给界面（`approval-gate.ts`）；
 * - 改动记录：经 `changes.record` 交给主进程（`change-recorder.ts`）；
 * - 检查点（M1-12b）：`host.init` 带 `checkpoints` 且注入了 `openCheckpoints` 时，每轮开始与执行命令前
 *   在项目的影子仓库中创建（`checkpoints.ts`）；否则不创建。
 *
 * 系统提示词（M1-13b）：`buildSystemPrompt` 组装基础提示词、`host.init` 的自定义说明与环境信息（操作系统、
 * `registerTools` 给出的 shell、工作区、当前日期）。
 *
 * 运行时与模型解析由入口注入，M1 换成 pi 适配器时这里不改。不依赖 Electron。
 */
import {
  createPermissionEngine,
  createRunSupervisor,
  createToolPipeline,
  createToolRegistry,
  DEFAULT_PERMISSION_GUARDS,
  presetRules,
  buildSystemPrompt,
  operatingSystemName,
  toolOutputBudget,
  type AgentRunHandle,
  type AgentRuntime,
  type Logger,
  type PermissionGate,
  type ResolvedModel,
  type RunSupervisor,
  type ToolCheckpoints,
  type ToolRegistry,
} from '@nexus/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  RpcError,
  type HostModelConfig,
  type ModelRef,
  type PermissionRule,
  type RpcChannel,
  type RpcEndpoint,
} from '@nexus/protocol'
import { createPathResolver } from '@nexus/tools'
import { createHostApprovalGate } from './approval-gate.js'
import { createHostCheckpoints, type OpenShadowRepo } from './checkpoints.js'
import { createHostChangeRecorder } from './change-recorder.js'

export const AgentHostErrorCode = {
  /** 尚未收到 `host.init`，或重复初始化。 */
  NotInitialized: 'host.not_initialized',
  AlreadyInitialized: 'host.already_initialized',
} as const

/** `host.init` 带来的凭据（M1-03b）。 */
export interface HostCredential {
  readonly apiKey: string
}

/** 一次初始化所用的运行时与模型。 */
export interface HostRuntime {
  readonly runtime: AgentRuntime
  readonly model: ResolvedModel
}

export interface AgentHostOptions {
  readonly channel: RpcChannel
  /**
   * 按 `host.init` 的模型、凭据与模型配置创建运行时（`runtime-select.ts`）。凭据只在内存中使用。
   */
  readonly createRuntime: (
    model: ModelRef,
    credential: HostCredential | undefined,
    modelConfig: HostModelConfig | undefined,
  ) => HostRuntime | Promise<HostRuntime>
  /** 退出进程（`host.shutdown` 回复之后调用）。 */
  readonly exit: (code: number) => void
  /** 轮次、步骤、消息的 id；必须全局唯一（同一运行跨宿主重启也不能重复）。 */
  readonly createId: () => string
  readonly now?: () => number
  /** 权限规则中的路径与命令是否不区分大小写（Windows）。默认 false。 */
  readonly caseInsensitive?: boolean
  /**
   * 注册工作区可用的工具（M1-11a）；省略或没有注册工具时运行不带工具。可以返回工具的环境信息
   * （`run_command` 使用的 shell），写入系统提示词（M1-13b）。
   */
  readonly registerTools?: (
    registry: ToolRegistry,
    workspacePath: string,
  ) => void | ToolEnvironment | Promise<void | ToolEnvironment>
  /** 操作系统（`process.platform` 的值），写入系统提示词；默认当前进程的。 */
  readonly platform?: string
  /** 打开项目的影子仓库（M1-12b，`@nexus/checkpoint` 的 `openShadowRepo`）；省略时不创建检查点。 */
  readonly openCheckpoints?: OpenShadowRepo
  /** 工具流水线的日志，默认不记录。 */
  readonly log?: Logger
  /** 记录异常（如排队的输入执行失败）。 */
  readonly onError?: (error: unknown) => void
}

/** 工具的环境信息（M1-13b）。 */
export interface ToolEnvironment {
  /** `run_command` 使用的 shell（`describeShell`）。 */
  readonly shell?: string
}

/** 本地日期 `YYYY-MM-DD`。 */
function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface AgentHost {
  readonly endpoint: RpcEndpoint<typeof HostForMain, typeof MainForHost>
  /** 工具调用的权限判定（M1-10c），使用 `host.init` 下发的规则。 */
  readonly permissions: PermissionGate
}

const silentLogger: Logger = {
  level: 'error',
  setLevel: () => undefined,
  isEnabled: () => false,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
}

/** 没有配置检查点：不创建，流水线与运行照常进行。 */
const NO_CHECKPOINTS: ToolCheckpoints = { create: () => Promise.resolve(undefined) }

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const now = options.now ?? Date.now
  const onError = (error: unknown) => options.onError?.(error)
  const endpoint = createEndpoint(options.channel, { local: HostForMain, remote: MainForHost })
  const shutdown = new AbortController()
  let supervisor: RunSupervisor | undefined
  let run: AgentRunHandle | undefined
  let initializing = false
  let permissionRules: readonly PermissionRule[] = presetRules('ask')
  const permissions = createPermissionEngine({
    rules: () => permissionRules,
    guards: DEFAULT_PERMISSION_GUARDS,
    ...(options.caseInsensitive !== undefined ? { caseInsensitive: options.caseInsensitive } : {}),
  })

  const requireRun = () => {
    if (!run) throw new RpcError(AgentHostErrorCode.NotInitialized)
    return run
  }

  endpoint.handle('host.init', async (init) => {
    if (initializing || run) throw new RpcError(AgentHostErrorCode.AlreadyInitialized)
    initializing = true
    if (init.permissionRules) permissionRules = init.permissionRules
    const checkpoints =
      init.checkpoints && options.openCheckpoints
        ? createHostCheckpoints({
            gitDir: init.checkpoints.gitDir,
            ref: init.checkpoints.ref,
            workTree: init.workspacePath,
            open: options.openCheckpoints,
            onError,
          })
        : NO_CHECKPOINTS
    const { runtime, model } = await options.createRuntime(
      init.model,
      init.credential,
      init.modelConfig,
    )
    const registry = createToolRegistry()
    const toolEnvironment = (await options.registerTools?.(registry, init.workspacePath)) ?? {}
    const hasTools = registry.list().length > 0
    // 系统提示词（M1-13b）：基础提示词、用户的自定义说明与环境信息
    const systemPrompt = buildSystemPrompt({
      tools: hasTools,
      environment: {
        os: operatingSystemName(options.platform ?? process.platform),
        ...(hasTools && toolEnvironment.shell ? { shell: toolEnvironment.shell } : {}),
        workspacePath: init.workspacePath,
        date: localDate(now()),
      },
      ...(init.instructions ? { userInstructions: init.instructions } : {}),
    })
    const toolPipeline = hasTools
      ? createToolPipeline({
          registry,
          permissions,
          approvals: createHostApprovalGate({
            endpoint,
            onRule: (rule) => (permissionRules = [...permissionRules, rule]),
          }),
          checkpoints,
          changes: createHostChangeRecorder(endpoint),
          workspaceRoot: init.workspacePath,
          resolvePath: createPathResolver(init.workspacePath),
          log: options.log ?? silentLogger,
          // 单个工具结果的上限按模型的上下文窗口计算（M1-13a）
          maxOutputTokens: toolOutputBudget(model.profile),
          createId: options.createId,
        })
      : undefined
    supervisor = createRunSupervisor({
      runtime,
      model,
      limits: init.limits,
      systemPrompt,
      signal: shutdown.signal,
      createId: options.createId,
      now,
      ...(toolPipeline ? { tools: registry.specs(), toolPipeline } : {}),
      checkpoints,
      onCheckpointError: onError,
    })
    supervisor.onEvent((event) => endpoint.emit('host.event', { event }))
    run = await supervisor.createRun({
      sessionId: init.sessionId,
      runId: init.runId,
      agent: init.agent,
      workspace: { path: init.workspacePath },
      mode: init.mode,
      ...(init.resume
        ? { restoreFrom: { runId: init.runId, history: init.history, state: init.resume.state } }
        : {}),
    })
    return {}
  })

  endpoint.handle('host.prompt', (input) => {
    // 一轮结束才 resolve；结果以事件回传，这里不等待
    requireRun().send(input).catch(onError)
    return {}
  })

  endpoint.handle('host.abort', async ({ reason }) => {
    await requireRun().abort(reason)
    return {}
  })

  endpoint.handle('host.shutdown', async () => {
    await supervisor?.abortAll('shutdown')
    shutdown.abort()
    // 先让回复发出，再退出
    setTimeout(() => {
      endpoint.close()
      options.exit(0)
    }, 0)
    return {}
  })

  endpoint.handle('host.permissions.update', ({ rules }) => {
    permissionRules = rules
    return {}
  })

  endpoint.handle('host.heartbeat', () => ({ ts: now() }))

  return { endpoint, permissions }
}
