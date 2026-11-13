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
 * 系统提示词（M1-13b，M3-02，M3-07）：`buildSystemPrompt` 组装基础提示词、`host.init` 的自定义说明与环境信息
 * （操作系统、`registerTools` 给出的 shell、工作区、当前日期）。每轮开始再向主进程要一次 `AGENTS.md` 和技能索引，
 * 换上这一轮的系统提示词。固定加载的技能正文一并注入，过长时截断。主进程没有这些接口时（测试）跳过，不记日志。
 *
 * 运行时与模型解析由入口注入，M1 换成 pi 适配器时这里不改。不依赖 Electron。
 */
import {
  createAgentPathGuard,
  createPermissionEngine,
  createRunSupervisor,
  createToolPipeline,
  createToolRegistry,
  combinePermissionGates,
  DEFAULT_PERMISSION_GUARDS,
  DELEGATE_RESULT_INSTRUCTION,
  DelegationSession,
  delegateToolSpec,
  PermissionReasonCode,
  resolveDelegationPolicy,
  runDelegation,
  presetRules,
  buildSystemPrompt,
  buildRunSnapshot,
  operatingSystemName,
  toolSelected,
  toolOutputBudget,
  planModeGuard,
  planToolVisible,
  registerPlanTools,
  sandboxGuard,
  type AgentRunHandle,
  type AgentRuntime,
  type DelegationChain,
  type DelegationTarget,
  type Logger,
  type ModelCallSnapshot,
  type PermissionGate,
  type PermissionGuard,
  type RetryPolicy,
  type ResolvedModel,
  type RunContext,
  type RunSupervisor,
  type SandboxGuardState,
  type ToolCheckpoints,
  ToolError,
  ToolErrorCode,
  type JsonSchema,
  type ToolRegistry,
} from '@cairn/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  RpcError,
  type ActivePlan,
  type AgentDefinition,
  type DelegateChanges,
  DelegateInput,
  type HostModelConfig,
  type McpToolExposure,
  type ModelRef,
  type PermissionMode,
  type PermissionRule,
  type RpcChannel,
  type RpcEndpoint,
  type SandboxCapability,
  type SandboxExecution,
  type SandboxPolicy,
  type SandboxUnavailableBehavior,
  type ShellPreference,
  type SkillCatalogEntry,
  sandboxExecution,
} from '@cairn/protocol'
import { SKILL_PIN_MAX_CHARS } from '@cairn/skills'
import { createLoadSkillTool, createPathResolver, createStartCommandTool } from '@cairn/tools'
import { createHostApprovalGate } from './approval-gate.js'
import { createHostCheckpoints, type OpenShadowRepo } from './checkpoints.js'
import { createHostChangeRecorder } from './change-recorder.js'

export const AgentHostErrorCode = {
  /** 尚未收到 `host.init`，或重复初始化。 */
  NotInitialized: 'host.not_initialized',
  AlreadyInitialized: 'host.already_initialized',
} as const

/**
 * 同一会话的并发运行上限（M4-13）：一个根运行加委派的子运行。
 * 超出时新的根运行排队；子运行由委派策略约束，不排队（见 `RunSupervisorOptions.maxRuns`）。
 */
export const DEFAULT_MAX_RUNS = 8

/** `host.init` 带来的凭据（M1-03b）。 */
export interface HostCredential {
  readonly apiKey: string
}

/** 一次初始化所用的运行时与模型。 */
export interface HostRuntime {
  readonly runtime: AgentRuntime
  readonly model: ResolvedModel
}

/** `host.delegate` 解析出的目标（M4-02）；凭据只在宿主内存中使用。 */
interface DelegatedTarget {
  readonly definition: AgentDefinition
  readonly model: ModelRef
  readonly credential?: { readonly apiKey: string } | undefined
  readonly modelConfig?: HostModelConfig | undefined
  readonly permissionRules: readonly PermissionRule[]
  readonly skills: readonly SkillCatalogEntry[]
  readonly mcpTools: readonly McpToolExposure[]
  readonly workspace: 'shared' | 'isolated'
}

/** 子运行使用的工作区（M4-08）：共享父工作区，或主进程创建的隔离副本。 */
interface DelegatedWorkspace {
  readonly path: string
  readonly checkpoints: ToolCheckpoints
  /** 嵌套委派的基线影子仓库；省略时主进程按会话解析。 */
  readonly gitDir?: string
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
   * （`run_command` 使用的 shell），写入系统提示词（M1-13b）。`shell` 是设置中的 shell 偏好（M2-09）。
   */
  readonly registerTools?: (
    registry: ToolRegistry,
    workspacePath: string,
    shell: ShellPreference,
    sandbox?: HostSandboxConfig,
  ) => void | ToolEnvironment | Promise<void | ToolEnvironment>
  /** 操作系统（`process.platform` 的值），写入系统提示词；默认当前进程的。 */
  readonly platform?: string
  /** 打开项目的影子仓库（M1-12b，`@cairn/checkpoint` 的 `openShadowRepo`）；省略时不创建检查点。 */
  readonly openCheckpoints?: OpenShadowRepo
  /** 工具流水线的日志，默认不记录。 */
  readonly log?: Logger
  /** 模型请求的重试策略（M1-14a），默认 `DEFAULT_RETRY_POLICY`。 */
  readonly retry?: RetryPolicy
  /** 同一会话的并发运行上限（M4-13），默认 `DEFAULT_MAX_RUNS`。 */
  readonly maxRuns?: number
  /** 名额已满时子运行可临时占用的溢出名额（M4-13），默认 8。 */
  readonly maxOverflowRuns?: number
  /** 记录异常（如排队的输入执行失败）。 */
  readonly onError?: (error: unknown) => void
}

/** 工具的环境信息（M1-13b）。 */
export interface ToolEnvironment {
  /** `run_command` 使用的 shell（`describeShell`）。 */
  readonly shell?: string
}

/** `host.init` 下发的命令沙箱配置（M5-04）：策略、能力与不可用时的行为。 */
export interface HostSandboxConfig {
  readonly policy: SandboxPolicy
  readonly capability: SandboxCapability
  readonly unavailable: SandboxUnavailableBehavior
  readonly appContainerName?: string | undefined
  /**
   * 沙箱里的子进程起不来时调用（M5-04）：把沙箱标记为不可用，让权限守卫按设置拒绝或要求
   * 审批后在沙箱外运行，而不是让每条命令都以 `0xC0000142` 失败。
   */
  readonly onUnusable?: (() => void) | undefined
}

/**
 * 只读 Agent 强制只读沙箱（M5-04）：根运行与委派子运行共用同一规则，
 * 不能靠权限预设或父运行的写入档位放宽。
 */
function sandboxFor(
  sandbox: HostSandboxConfig | undefined,
  definition: AgentDefinition | undefined,
): HostSandboxConfig | undefined {
  if (!sandbox || definition?.permissions !== 'read-only') return sandbox
  return { ...sandbox, policy: { ...sandbox.policy, profile: 'read-only' } }
}

/** 固定加载的正文过长时截断，其余仍可由 `load_skill` 读取。 */
function pinnedSkillBody(body: string): string {
  const chars = [...body]
  if (chars.length <= SKILL_PIN_MAX_CHARS) return body
  return `${chars.slice(0, SKILL_PIN_MAX_CHARS).join('')}\n\n[Truncated: this pinned skill is longer than 32 KB. Call load_skill to read the rest.]`
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

const noop = () => undefined
const silentLogger: Logger = {
  level: 'error',
  setLevel: noop,
  isEnabled: () => false,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
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
  /**
   * 命令沙箱状态（M5-04）：`host.init` 之前按“平台不支持”处理，不拦截测试中的直接调用；
   * 初始化后按实际能力与策略判定。
   */
  let sandboxState: SandboxGuardState = {
    supported: false,
    available: true,
    unavailable: 'deny',
    profile: 'workspace-write',
  }
  /** 当前这一轮是不是计划模式（M3-05）。轮次结束后清掉，权限拦截读它。 */
  let planTurn = false
  /** 正在执行的已批准计划。下一次 `host.prompt` 会换掉或清掉。 */
  let activePlan: ActivePlan | undefined
  /**
   * 共享写入锁（M4-08）：同一会话同一时刻只允许一个写入类子运行修改父工作区。宿主按会话创建，
   * 因此内存中的队列就够用；隔离工作区不受这个锁限制，可以并行。
   */
  let sharedWriteTail: Promise<void> = Promise.resolve()
  const acquireSharedWrite = (): Promise<() => void> => {
    let release!: () => void
    const mine = new Promise<void>((resolve) => (release = resolve))
    const previous = sharedWriteTail
    sharedWriteTail = previous.then(() => mine)
    return previous.then(() => () => release())
  }
  /** 根运行的 Agent 定义；路径守卫在 `host.init` 拿到定义后才生效。 */
  let agentDefinition: AgentDefinition | undefined
  let rootPathGuard: PermissionGuard = () => undefined
  /** 可委派目标的权限模式（M4-03）：委派给写入类 Agent 默认需要审批。 */
  const delegationTargetModes = new Map<string, PermissionMode>()
  const delegationApprovalGuard: PermissionGuard = (request) => {
    if (request.definition.name !== 'delegate') return undefined
    const input = request.input as { readonly agent?: unknown } | null
    const agent = input && typeof input.agent === 'string' ? input.agent : undefined
    const mode = agent === undefined ? undefined : delegationTargetModes.get(agent)
    if (mode === undefined || mode === 'read-only') return undefined
    return { effect: 'ask', reasonCode: PermissionReasonCode.DelegationTarget }
  }
  const permissions = createPermissionEngine({
    rules: () => permissionRules,
    guards: [
      ...DEFAULT_PERMISSION_GUARDS,
      planModeGuard(() => planTurn),
      delegationApprovalGuard,
      sandboxGuard(() => sandboxState),
      (request) => rootPathGuard(request),
    ],
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
    /**
     * 计划模式与只读 Agent 强制只读沙箱（M5-04）：权限预设已经拒绝写入类调用，这里是第二层，
     * 不能靠用户把预设改成“自动”而放宽。
     */
    const effectiveSandbox = sandboxFor(init.sandbox, init.agentDefinition)
    if (effectiveSandbox) {
      sandboxState = {
        supported: effectiveSandbox.capability.supported,
        available: effectiveSandbox.capability.available,
        unavailable: effectiveSandbox.unavailable,
        profile: effectiveSandbox.policy.profile,
      }
    }
    /**
     * 沙箱在实际执行中起不来（子进程加载阶段就退出）：把能力改成不可用，权限守卫随即按设置
     * 拒绝或要求审批后在沙箱外运行（M5-04）。只改这一次运行内的状态，不改设置。
     */
    const withUnusableFallback = (config: HostSandboxConfig): HostSandboxConfig => ({
      ...config,
      onUnusable: () => {
        if (!sandboxState.available) return
        sandboxState = { ...sandboxState, available: false }
      },
    })
    const sandboxExecutionInfo: SandboxExecution | undefined = effectiveSandbox
      ? sandboxExecution(effectiveSandbox.policy, effectiveSandbox.capability)
      : undefined
    const checkpoints =
      init.checkpoints && options.openCheckpoints
        ? createHostCheckpoints({
            gitDir: init.checkpoints.gitDir,
            ref: init.checkpoints.ref,
            workTree: init.workspacePath,
            open: options.openCheckpoints,
            ...(init.git
              ? { gitBinary: init.git.binary, ...(init.git.env ? { gitEnv: init.git.env } : {}) }
              : {}),
            onError,
          })
        : NO_CHECKPOINTS
    const { runtime, model } = await options.createRuntime(
      init.model,
      init.credential,
      init.modelConfig,
    )
    const registry = createToolRegistry()
    const toolEnvironment =
      (effectiveSandbox
        ? await options.registerTools?.(
            registry,
            init.workspacePath,
            init.shell ?? 'auto',
            withUnusableFallback(effectiveSandbox),
          )
        : await options.registerTools?.(registry, init.workspacePath, init.shell ?? 'auto')) ?? {}
    const hasBuiltinTools = registry.list().length > 0
    /** Agent 定义（M3-11）：决定这一份运行的指令、工具选择与上下文策略。 */
    agentDefinition = init.agentDefinition
    rootPathGuard = createAgentPathGuard(agentDefinition?.pathPolicy, {
      ...(options.caseInsensitive !== undefined
        ? { caseInsensitive: options.caseInsensitive }
        : {}),
    })
    /** 注册 MCP 工具代理（根运行与委派子运行共用）。 */
    const registerMcpToolsInto = (
      target: ToolRegistry,
      tools: readonly McpToolExposure[],
    ): void => {
      for (const tool of tools) {
        if (target.get(tool.name)) {
          onError(new Error(`MCP tool name conflicts with a builtin tool: ${tool.name}`))
          continue
        }
        target.register({
          name: tool.name,
          description: tool.description || `MCP tool ${tool.originalName}`,
          inputSchema: tool.inputSchema,
          category: tool.category,
          source: { kind: 'mcp', serverId: tool.serverId },
          trust: 'third-party',
          async execute(input, ctx) {
            const result = await endpoint.request('host.mcp.call', {
              serverId: tool.serverId,
              toolName: tool.originalName,
              input: input as Record<string, unknown>,
              maxOutputTokens: ctx.maxOutputTokens,
            })
            if (result.isError) {
              throw new ToolError(ToolErrorCode.ExecutionFailed, result.text)
            }
            return { content: [{ type: 'text', text: result.text }] }
          },
        })
      }
    }
    const visibleSpecs = (mode: 'normal' | 'plan', executing: boolean) =>
      registry.specs(
        (definition) =>
          planToolVisible(definition.name, mode, executing) &&
          toolSelected(agentDefinition?.tools, definition),
      )
    registerMcpToolsInto(registry, init.mcpTools ?? [])
    /** 本轮启用的技能。`prepareTurn` 每轮替换，`load_skill` 按名称读取。 */
    const skillCatalog: SkillCatalogEntry[] = []
    /** 技能目录只读。与 `skillCatalog` 一起每轮更新。 */
    const readOnlyRoots: string[] = []
    if (hasBuiltinTools) {
      registry.register(
        createStartCommandTool({
          start: (input) => {
            return endpoint.request('host.command.start', {
              ...input,
              runId: run?.runId ?? init.runId,
            })
          },
          ...(effectiveSandbox ? { sandbox: effectiveSandbox.policy } : {}),
          ...(sandboxExecutionInfo ? { execution: sandboxExecutionInfo } : {}),
        }),
      )
      registry.register(
        createLoadSkillTool(() =>
          skillCatalog.map((skill) => ({
            name: skill.name,
            description: skill.description,
            sha256: skill.sha256,
            body: skill.body,
            hasScripts: skill.hasScripts,
            files: skill.files,
            ...(skill.filesTruncated ? { filesTruncated: true as const } : {}),
          })),
        ),
      )
    }

    /** 可委派目标的名称与描述（M4-02）；主进程没有这个接口时只列 id。 */
    async function loadDelegateTargets(agentIds: readonly string[]) {
      try {
        const { targets } = await endpoint.request('host.delegate.targets', {
          agents: [...agentIds],
        })
        for (const target of targets) delegationTargetModes.set(target.id, target.permissions)
        return targets
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found') onError(error)
        return agentIds.map((id) => ({ id, name: id, description: '' }))
      }
    }

    /** 把一次模型调用的上下文交给主进程存成检查器快照（M4-04）。 */
    function reportModelCall(
      call: ModelCallSnapshot,
      skills: readonly { name: string; description: string; pinned: boolean }[],
    ): void {
      const snapshot = buildRunSnapshot({
        runId: call.runId,
        ...(call.parentRunId ? { parentRunId: call.parentRunId } : {}),
        agent: call.agent,
        model: call.model.ref,
        ...(call.turnId ? { turnId: call.turnId } : {}),
        ...(call.stepId ? { stepId: call.stepId } : {}),
        systemPrompt: call.systemPrompt,
        tools: call.tools,
        skills,
        history: call.messages,
        ...(call.compaction
          ? {
              compaction: {
                summary: call.compaction.summary,
                coversTurns: call.compaction.coversTurns,
                ...(call.compaction.tokensBefore === undefined
                  ? {}
                  : { tokensBefore: call.compaction.tokensBefore }),
                ...(call.compaction.tokensAfter === undefined
                  ? {}
                  : { tokensAfter: call.compaction.tokensAfter }),
              },
            }
          : {}),
      })
      void endpoint.request('host.snapshot', snapshot).catch((error: unknown) => {
        // 测试或旧主进程没有这个接口；其他错误只记日志。
        if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found') onError(error)
      })
    }

    /**
     * 构造委派子运行的工具与上下文（M4-02）：独立的运行时、工具选择、权限规则、Skills 与系统提示词。
     * 子运行可以继续委派时，按同一条链登记 `delegate`。
     */
    async function buildDelegatedContext(
      resolved: DelegatedTarget,
      chain: DelegationChain,
      handleRef: { current?: AgentRunHandle },
      parentGate: PermissionGate,
      parentRunId: string,
      workspace: DelegatedWorkspace,
    ): Promise<RunContext> {
      const definition = resolved.definition
      const childSandbox = sandboxFor(effectiveSandbox, definition)
      const childSandboxExecution = childSandbox
        ? sandboxExecution(childSandbox.policy, childSandbox.capability)
        : undefined
      const child = await options.createRuntime(
        resolved.model,
        resolved.credential,
        resolved.modelConfig,
      )
      const childRegistry = createToolRegistry()
      const environment =
        (childSandbox
          ? await options.registerTools?.(
              childRegistry,
              workspace.path,
              init.shell ?? 'auto',
              withUnusableFallback(childSandbox),
            )
          : await options.registerTools?.(childRegistry, workspace.path, init.shell ?? 'auto')) ??
        {}
      registerMcpToolsInto(childRegistry, resolved.mcpTools)
      childRegistry.register(
        createStartCommandTool({
          start: (input) => {
            return endpoint.request('host.command.start', {
              ...input,
              runId: handleRef.current?.runId ?? parentRunId,
            })
          },
          ...(childSandbox ? { sandbox: childSandbox.policy } : {}),
          ...(childSandboxExecution ? { execution: childSandboxExecution } : {}),
        }),
      )
      const skills = [...resolved.skills]
      const roots = skills.map((skill) => skill.root)
      if (childRegistry.list().length > 0) {
        childRegistry.register(
          createLoadSkillTool(() =>
            skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              sha256: skill.sha256,
              body: skill.body,
              hasScripts: skill.hasScripts,
              files: skill.files,
              ...(skill.filesTruncated ? { filesTruncated: true as const } : {}),
            })),
          ),
        )
      }
      const policy = resolveDelegationPolicy(definition.delegation)
      let rules: readonly PermissionRule[] = [...resolved.permissionRules]
      const childPermissions = createPermissionEngine({
        rules: () => rules,
        guards: [
          ...DEFAULT_PERMISSION_GUARDS,
          delegationApprovalGuard,
          createAgentPathGuard(definition.pathPolicy, {
            ...(options.caseInsensitive !== undefined
              ? { caseInsensitive: options.caseInsensitive }
              : {}),
          }),
        ],
        ...(options.caseInsensitive !== undefined
          ? { caseInsensitive: options.caseInsensitive }
          : {}),
      })
      // 嵌套委派继承整条祖先链：下一层以“父运行限制 ∩ 当前子 Agent 权限”为上限。
      const effectiveGate = combinePermissionGates(parentGate, childPermissions)
      await registerDelegateTool(
        childRegistry,
        policy,
        chain,
        handleRef,
        effectiveGate,
        parentRunId,
        workspace.checkpoints,
        workspace.path,
        workspace.gitDir,
      )
      const specs = childRegistry.specs((tool) => toolSelected(definition.tools, tool))
      const hasTools = specs.length > 0
      const childPipeline = hasTools
        ? createToolPipeline({
            registry: childRegistry,
            permissions: childPermissions,
            restriction: parentGate,
            approvals: createHostApprovalGate({
              endpoint,
              onRule: (rule) => (rules = [...rules, rule]),
              attribution: () => ({
                runId: handleRef.current?.runId ?? '',
                parentRunId,
                agent: { id: definition.id, version: definition.version },
              }),
            }),
            checkpoints: workspace.checkpoints,
            changes: createHostChangeRecorder(endpoint),
            workspaceRoot: workspace.path,
            resolvePath: createPathResolver(workspace.path, {
              readOnlyRoots: () => roots,
            }),
            log: options.log ?? silentLogger,
            maxOutputTokens: toolOutputBudget(child.model.profile),
            createId: options.createId,
          })
        : undefined
      const prompt = buildSystemPrompt({
        tools: hasTools,
        environment: {
          os: operatingSystemName(options.platform ?? process.platform),
          ...(hasTools && environment.shell ? { shell: environment.shell } : {}),
          workspacePath: workspace.path,
          date: localDate(now()),
        },
        ...(definition.instructions.trim() ? { agentInstructions: definition.instructions } : {}),
        ...(skills.some((skill) => skill.pinned)
          ? {
              skills: skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                ...(skill.pinned ? { body: pinnedSkillBody(skill.body) } : {}),
              })),
            }
          : {}),
      })
      const systemPrompt = `${prompt}\n\n${DELEGATE_RESULT_INSTRUCTION}`
      return {
        runtime: child.runtime,
        model: child.model,
        limits: definition.limits,
        systemPrompt,
        onModelCall: (call) =>
          reportModelCall(
            call,
            resolved.skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              pinned: skill.pinned,
            })),
          ),
        tools: specs,
        checkpoints: workspace.checkpoints,
        onCheckpointError: onError,
        ...(childPipeline ? { toolPipeline: childPipeline } : {}),
      }
    }

    /**
     * 登记 `delegate` 工具（M4-02）：权限 → 校验 → 解析目标 → 创建子运行 → 等待 → 结构化结果。
     * 未启用委派、没有可委派目标或深度已到上限时不登记，模型看不到这个工具。
     */
    async function registerDelegateTool(
      target: ToolRegistry,
      policy: ReturnType<typeof resolveDelegationPolicy>,
      chain: DelegationChain,
      handleRef: { current?: AgentRunHandle },
      parentGate: PermissionGate,
      parentRunId: string,
      parentCheckpoints: ToolCheckpoints,
      parentWorkspacePath: string,
      parentGitDir?: string,
    ): Promise<void> {
      const maxDepth = Math.min(chain.maxDepth ?? policy.maxDepth, policy.maxDepth)
      if (!policy.enabled || policy.allowedAgents.length === 0 || chain.depth + 1 > maxDepth) {
        return
      }
      const spec = delegateToolSpec(await loadDelegateTargets(policy.allowedAgents))
      if (!spec) return
      let session: DelegationSession | undefined
      target.register({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema as JsonSchema,
        category: 'delegate',
        source: { kind: 'builtin' },
        trust: 'builtin',
        parallel: true,
        async execute(raw) {
          const parsed = DelegateInput.safeParse(raw)
          if (!parsed.success) {
            throw new ToolError(
              ToolErrorCode.InvalidInput,
              `Invalid delegate input: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; ')}`,
            )
          }
          const input = parsed.data
          const parent = handleRef.current
          if (!parent) {
            throw new ToolError(ToolErrorCode.ExecutionFailed, 'Delegation is not ready yet.')
          }
          session ??= new DelegationSession({ policy, parent, chain })
          const remaining = parent.remainingLimits
          const validation = session.validate(input, {
            ...(remaining ? { parentRemaining: remaining } : {}),
          })
          if (!validation.ok) {
            const problem = validation.issues.find((entry) => entry.severity === 'error')
            if (problem) {
              throw new ToolError(problem.code, problem.code, problem.params ?? {})
            }
          }
          let resolved: DelegatedTarget
          try {
            resolved = await endpoint.request('host.delegate', { agent: input.agent })
          } catch (error) {
            if (error instanceof RpcError) {
              throw new ToolError(
                error.code,
                `Cannot delegate to ${input.agent}: ${error.code}`,
                error.params ?? {},
              )
            }
            throw error
          }
          const childPolicy = resolveDelegationPolicy(resolved.definition.delegation)
          const childChain: DelegationChain = {
            agentIds: [...chain.agentIds, resolved.definition.id],
            depth: chain.depth + 1,
            maxDepth: Math.min(maxDepth, childPolicy.maxDepth),
          }
          const childHandleRef: { current?: AgentRunHandle } = {}
          const childRunId = options.createId()
          const readOnly = resolved.definition.permissions === 'read-only'
          const requested = input.workspace ?? policy.defaultWorkspace
          let workspaceMode: 'shared' | 'isolated' =
            requested === 'auto' ? (readOnly ? 'shared' : 'isolated') : requested
          let workspacePath = parentWorkspacePath
          let childCheckpoints = parentCheckpoints
          let childGitDir = parentGitDir
          let isolatedRunId: string | undefined
          let releaseShared: (() => void) | undefined
          try {
            if (workspaceMode === 'isolated') {
              let baseCommit: string | undefined
              try {
                baseCommit = await parentCheckpoints.create('delegation')
              } catch (error) {
                onError(error)
              }
              if (baseCommit === undefined) {
                // 没有可用的检查点（未安装 Git 等）：退化为共享写入，由会话级锁串行。
                workspaceMode = 'shared'
              } else {
                try {
                  const created = await endpoint.request('host.workspace.create', {
                    projectPath: parentWorkspacePath,
                    baseCommit,
                    sessionId: init.sessionId,
                    runId: childRunId,
                    ...(parentGitDir !== undefined ? { gitDir: parentGitDir } : {}),
                  })
                  workspacePath = created.path
                  isolatedRunId = childRunId
                  childGitDir = created.checkpoint.gitDir
                  childCheckpoints = options.openCheckpoints
                    ? createHostCheckpoints({
                        gitDir: created.checkpoint.gitDir,
                        ref: created.checkpoint.ref,
                        workTree: created.path,
                        open: options.openCheckpoints,
                        ...(init.git
                          ? {
                              gitBinary: init.git.binary,
                              ...(init.git.env ? { gitEnv: init.git.env } : {}),
                            }
                          : {}),
                        extraExcludes: ['.git'],
                        onError,
                      })
                    : NO_CHECKPOINTS
                } catch (error) {
                  // 主进程没有隔离工作区服务、磁盘配额或创建失败：回退到共享写入。
                  onError(error)
                  workspaceMode = 'shared'
                }
              }
            }
            if (workspaceMode === 'shared' && !readOnly) {
              releaseShared = await acquireSharedWrite()
            }
            const context = await buildDelegatedContext(
              resolved,
              childChain,
              childHandleRef,
              parentGate,
              handleRef.current?.runId ?? parentRunId,
              {
                path: workspacePath,
                checkpoints: childCheckpoints,
                ...(childGitDir !== undefined ? { gitDir: childGitDir } : {}),
              },
            )
            if (!supervisor) {
              throw new ToolError(ToolErrorCode.ExecutionFailed, 'The host is not ready.')
            }
            const result = await runDelegation({
              sessionId: init.sessionId,
              supervisor,
              parent,
              session,
              target: {
                definition: resolved.definition,
                context,
                workspace: { path: workspacePath },
              } satisfies DelegationTarget,
              input,
              childRunId,
              workspace: workspaceMode,
              parentRemaining: remaining ?? {},
              systemPrompt: context.systemPrompt ?? '',
              onChildCreated: (created) => (childHandleRef.current = created),
              ...(isolatedRunId !== undefined
                ? {
                    // 隔离工作区里的改动先算成改动集（`changeset.created` 早于 `run.child.completed`），
                    // 再由下面的 finally 清理工作区。
                    collectChanges: async (
                      childId: string,
                    ): Promise<DelegateChanges | undefined> => {
                      try {
                        const created = await endpoint.request('host.changeset.create', {
                          runId: childId,
                          parentRunId: parent.runId,
                        })
                        return {
                          changeSetId: created.changeSetId,
                          files: created.files,
                          merge: 'pending_review',
                        }
                      } catch (error) {
                        // 旧主进程没有这个接口，或改动集生成失败：委派结果照常返回。
                        if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found') {
                          onError(error)
                        }
                        return undefined
                      }
                    },
                  }
                : {}),
            })
            return { content: [{ type: 'text', text: JSON.stringify(result) }] }
          } finally {
            releaseShared?.()
            if (isolatedRunId !== undefined) {
              try {
                await endpoint.request('host.workspace.cleanup', { runId: isolatedRunId })
              } catch (error) {
                onError(error)
              }
            }
          }
        },
      })
    }

    const rootPolicy = resolveDelegationPolicy(agentDefinition?.delegation)
    const rootHandleRef: { current?: AgentRunHandle } = {}
    await registerDelegateTool(
      registry,
      rootPolicy,
      {
        agentIds: agentDefinition ? [agentDefinition.id] : [],
        depth: 0,
        maxDepth: rootPolicy.maxDepth,
      },
      rootHandleRef,
      permissions,
      init.runId,
      checkpoints,
      init.workspacePath,
    )

    /** 真正交给模型的内置 / MCP 工具（计划工具在 `prepareTurn` 里按模式加回）。 */
    const hasTools = registry
      .list()
      .some((definition) => toolSelected(agentDefinition?.tools, definition))
    registerPlanTools(registry, {
      createId: options.createId,
      activePlan: () => activePlan,
      revisePlan: (steps) => {
        if (activePlan) activePlan = { ...activePlan, steps: [...steps] }
      },
    })
    // 系统提示词（M1-13b）：基础提示词、用户的自定义说明与环境信息。项目说明每轮再补（M3-02）。
    const promptBase = {
      tools: hasTools,
      environment: {
        os: operatingSystemName(options.platform ?? process.platform),
        ...(hasTools && toolEnvironment.shell ? { shell: toolEnvironment.shell } : {}),
        workspacePath: init.workspacePath,
        date: localDate(now()),
      },
      ...(init.instructions ? { userInstructions: init.instructions } : {}),
      ...(agentDefinition?.instructions.trim()
        ? { agentInstructions: agentDefinition.instructions }
        : {}),
    }
    const systemPrompt = buildSystemPrompt(promptBase)
    const toolPipeline = hasTools
      ? createToolPipeline({
          registry,
          permissions,
          approvals: createHostApprovalGate({
            endpoint,
            onRule: (rule) => (permissionRules = [...permissionRules, rule]),
            attribution: () => ({
              runId: run?.runId ?? init.runId,
              agent: init.agent,
            }),
          }),
          checkpoints,
          changes: createHostChangeRecorder(endpoint),
          workspaceRoot: init.workspacePath,
          resolvePath: createPathResolver(init.workspacePath, {
            readOnlyRoots: () => readOnlyRoots,
          }),
          log: options.log ?? silentLogger,
          // 单个工具结果的上限按模型的上下文窗口计算（M1-13a）
          maxOutputTokens: toolOutputBudget(model.profile),
          createId: options.createId,
        })
      : undefined
    supervisor = createRunSupervisor({
      runtime,
      model,
      maxRuns: options.maxRuns ?? DEFAULT_MAX_RUNS,
      ...(options.maxOverflowRuns !== undefined
        ? { maxOverflowRuns: options.maxOverflowRuns }
        : {}),
      limits: init.limits,
      systemPrompt,
      prepareTurn: async () => {
        let text: string | undefined
        let context:
          | { agentsMd: { sha256: string; bytes: number; truncated: boolean; lines: number } }
          | undefined
        if (agentDefinition?.context.includeProjectInstructions !== false) {
          try {
            const loaded = await endpoint.request('host.agentsMd', {})
            text = loaded.text
            context = loaded.context
          } catch (error) {
            // 测试里的主进程没有这个接口。其他错误只记日志，这一轮不带项目说明。
            if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found')
              onError(error)
          }
        }
        try {
          const loaded = await endpoint.request('host.skills', {})
          skillCatalog.splice(0, skillCatalog.length, ...loaded.skills)
          readOnlyRoots.splice(0, readOnlyRoots.length, ...loaded.skills.map((skill) => skill.root))
        } catch (error) {
          skillCatalog.splice(0, skillCatalog.length)
          readOnlyRoots.splice(0, readOnlyRoots.length)
          // 测试里的主进程没有这个接口。其他错误只记日志，这一轮不带技能。
          if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found') onError(error)
        }
        const skills = skillCatalog.map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.pinned ? { body: pinnedSkillBody(skill.body) } : {}),
        }))
        const mode = planTurn ? 'plan' : 'normal'
        const executing = mode === 'normal' ? activePlan : undefined
        return {
          systemPrompt: buildSystemPrompt({
            ...promptBase,
            tools: promptBase.tools || mode === 'plan' || executing !== undefined,
            environment: { ...promptBase.environment, date: localDate(now()) },
            ...(text ? { projectInstructions: text } : {}),
            ...(skills.length > 0 ? { skills } : {}),
            ...(mode === 'plan'
              ? { plan: { kind: 'propose' as const } }
              : executing
                ? {
                    plan: {
                      kind: 'execute' as const,
                      goal: executing.goal,
                      steps: executing.steps,
                    },
                  }
                : {}),
          }),
          tools: visibleSpecs(mode, executing !== undefined),
          ...(context ? { context } : {}),
        }
      },
      onModelCall: (call) =>
        reportModelCall(
          call,
          skillCatalog.map((skill) => ({
            name: skill.name,
            description: skill.description,
            pinned: skill.pinned,
          })),
        ),
      onModelCallError: onError,
      signal: shutdown.signal,
      createId: options.createId,
      now,
      ...(toolPipeline
        ? {
            tools: visibleSpecs('normal', false),
            toolPipeline,
          }
        : {}),
      checkpoints,
      onCheckpointError: onError,
      ...(options.retry ? { retry: options.retry } : {}),
      sessionBrief: async () => {
        try {
          const result = await endpoint.request('host.sessionBrief', {})
          return result.text ?? ''
        } catch (error) {
          // 测试里的主进程没有这个接口。其他错误只记日志，这一轮不改要点。
          if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found') onError(error)
          return undefined
        }
      },
      summarize: async (transcript) => {
        try {
          const result = await endpoint.request(
            'host.summarize',
            { transcript },
            { timeoutMs: 120_000 },
          )
          return result.text
        } catch (error) {
          // 测试里的主进程没有这个接口。其他错误只记日志，这一次不写摘要。
          if (!(error instanceof RpcError) || error.code !== 'rpc.method_not_found') onError(error)
          return undefined
        }
      },
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
    rootHandleRef.current = run
    return {}
  })

  endpoint.handle('host.prompt', (input) => {
    // 引导：注入当前轮，在下一次模型调用前生效；不另起一轮，也不改这一轮的计划模式。
    if (input.send === 'steer') {
      // 正常执行的引导同步计划快照；只读计划轮不能借引导切换成执行模式。
      if (!planTurn && input.plan) activePlan = input.plan
      requireRun().send(input, 'steer').catch(onError)
      return {}
    }
    planTurn = input.mode === 'plan'
    activePlan = planTurn ? undefined : input.plan
    // 一轮结束才 resolve；结果以事件回传，这里不等待。计划模式的只读拦截维持到这一轮结束。
    requireRun()
      .send(input, input.send)
      .finally(() => {
        planTurn = false
      })
      .catch(onError)
    return {}
  })

  endpoint.handle('host.abort', async ({ reason }) => {
    await requireRun().abort(reason)
    return {}
  })

  endpoint.handle('host.compact', async () => ({ compacted: await requireRun().compact() }))

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
