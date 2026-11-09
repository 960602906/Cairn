/**
 * 主进程 ↔ Agent 宿主进程的接口（架构 §15.3，ADR-0003）。
 * 主进程控制宿主（请求），宿主把运行时事件推给主进程（事件，无 seq，由主进程分配）。
 */
import { z } from 'zod'
import {
  CanonicalMessage,
  ContentPart,
  Id,
  ModelRef,
  RunAgentRef,
  RunLimits,
  RunMode,
  RunState,
  Timestamp,
} from '../common.js'
import { AgentDefinition } from '../agents.js'
import { FileChangeInput } from '../changes.js'
import { BackgroundCommand } from '../commands.js'
import { AgentsMdContext, ApprovalDecision, UnsequencedEventSchema } from '../events.js'
import { RunSnapshotInput } from '../inspect.js'
import { ActivePlan, PromptMode } from '../plan.js'
import { PermissionMode, PermissionRule, ToolCategory } from '../permissions.js'
import { SandboxCapability, SandboxPolicy, SandboxUnavailableBehavior } from '../sandbox.js'
import { BaseUrl, ModelCompat, ModelProfile, ProviderKind } from '../providers.js'
import { defineSide } from '../rpc.js'
import { SkillCatalogEntry } from '../skills.js'
import { McpToolExposure } from '../mcp.js'

/**
 * 宿主构造模型所需的配置（M1-04b）：由主进程按提供方配置给出，不含 Key。
 * `compat` 已合并提供方与模型两级的兼容参数。
 */

/**
 * 命令执行使用的 shell（M2-09，ADR-0012）：`auto` 自动选择（Windows 优先非商店版 PowerShell 7，其次
 * Windows PowerShell 5.1）；`cmd` 只在 Windows 上有效。
 */
export const ShellPreference = z.enum(['auto', 'cmd'])
export type ShellPreference = z.infer<typeof ShellPreference>

export const HostModelConfig = z.object({
  kind: ProviderKind,
  baseUrl: BaseUrl,
  profile: ModelProfile.omit({ compat: true, displayName: true, verifiedAt: true }),
  compat: ModelCompat.optional(),
})
export type HostModelConfig = z.infer<typeof HostModelConfig>

/**
 * 隔离工作区（M4-08，ADR-0031）：宿主在主进程创建后拿到路径、创建方式、只读共享的依赖目录，以及
 * 子运行自己的检查点位置。子运行的路径校验、检查点与改动记录都以 `path` 为根。
 */
export const IsolatedWorkspaceInfo = z.object({
  path: z.string().min(1),
  mode: z.enum(['worktree', 'export']),
  /** 相对隔离工作区、以 `/` 分隔的依赖目录（`node_modules` 等）。 */
  sharedDirs: z.array(z.string()),
  checkpoint: z.object({
    gitDir: z.string().min(1),
    ref: z.string().min(1),
  }),
})
export type IsolatedWorkspaceInfo = z.infer<typeof IsolatedWorkspaceInfo>

/**
 * 宿主发起的审批请求（M1-11a，架构 §10.4）：界面显示工具、参数、预览与判定理由。
 * `kind`：`tool` 为权限判定需要审批；`no_checkpoint` 为检查点创建失败，确认是否不带检查点继续。
 */
export const HostApprovalRequest = z.object({
  approvalId: Id,
  toolCallId: Id,
  /** 发起这次调用的运行（M4-03）：子运行的审批不会归到父运行名下。 */
  runId: Id,
  parentRunId: Id.optional(),
  /** 发起调用的 Agent 定义（M4-03）。 */
  agent: RunAgentRef,
  tool: z.object({ name: z.string().min(1), category: ToolCategory }),
  /** 规范化后的参数（JSON）。 */
  input: z.unknown(),
  /** 权限判定用的目标：相对工作区的路径与命令。 */
  targets: z.object({
    paths: z.array(z.string()).optional(),
    command: z.string().optional(),
  }),
  kind: z.enum(['tool', 'no_checkpoint']),
  preview: z
    .object({
      summary: z.string(),
      diff: z.string().optional(),
      command: z.string().optional(),
    })
    .optional(),
  reasonCode: z.string().min(1),
  matchedRuleIds: z.array(Id),
})
export type HostApprovalRequest = z.infer<typeof HostApprovalRequest>

/**
 * 审批的结果。选择“本会话 / 本项目始终允许”时，主进程保存生成的规则并在 `rule` 中给出，宿主立即用它判定
 * 之后的调用。
 */
export const HostApprovalResponse = z.object({
  decision: ApprovalDecision,
  /** 用户附加的说明，拒绝时交给模型。 */
  feedback: z.string().optional(),
  rule: PermissionRule.optional(),
})
export type HostApprovalResponse = z.infer<typeof HostApprovalResponse>

export const HostForMain = defineSide({
  requests: {
    /** 会话配置与历史。模型凭据在 M1 加入（只经 MessagePort 传递，ADR-0010）。 */
    'host.init': {
      params: z.object({
        sessionId: Id,
        runId: Id,
        workspacePath: z.string().min(1),
        agent: RunAgentRef,
        /**
         * 这个运行引用的 Agent 定义（M3-11）。宿主据此决定指令、工具选择与是否读取项目说明。
         * 省略时按内置编程助手的行为：全部工具、没有额外指令。
         */
        agentDefinition: AgentDefinition.optional(),
        model: ModelRef,
        mode: RunMode,
        limits: RunLimits,
        history: z.array(CanonicalMessage),
        /**
         * 恢复已有的运行（不再发出 run.created）：运行当前记录的状态。运行中状态按中断处理
         * （Runtime §13.2）。省略表示新运行。
         */
        resume: z.object({ state: RunState }).optional(),
        /**
         * 模型的凭据（ADR-0010，M1-03b）：主进程解密后只经这里传给宿主，不写入环境变量与日志。
         * 没有保存凭据时省略（如本地模型、FakeRuntime）。
         */
        credential: z.object({ apiKey: z.string().min(1) }).optional(),
        /** 模型配置（M1-04b）。省略时宿主用 FakeRuntime，或开发用的环境变量。 */
        modelConfig: HostModelConfig.optional(),
        /**
         * 适用于这个会话的权限规则（M1-10c）：权限模式的预设、全局规则、会话所属项目的规则、会话的规则。
         * 省略时按“询问”模式的预设判定。
         */
        permissionRules: z.array(PermissionRule).optional(),
        /** 用户的自定义说明（M1-13b，设置中的 `instructions`），加入系统提示词。省略表示没有。 */
        instructions: z.string().min(1).optional(),
        /** 命令执行使用的 shell（M2-09，设置中的 `shell`）。省略时按 `auto`。 */
        shell: ShellPreference.optional(),
        /**
         * 检查点（M1-12b，ADR-0008）：项目的影子仓库目录（应用数据目录中）与这个会话的检查点引用。
         * 省略时不创建检查点。
         */
        checkpoints: z
          .object({
            gitDir: z.string().min(1),
            ref: z.string().regex(/^refs\/cairn\/[A-Za-z0-9._/-]+$/),
          })
          .optional(),
        /**
         * 检查点使用的 Git（M5-03）。省略时宿主使用 PATH 中的 `git`；随包 MinGit 还要带上
         * `GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR` 与包含同目录 DLL 的 `PATH`。
         */
        git: z
          .object({
            binary: z.string().min(1),
            env: z.record(z.string(), z.string()).optional(),
          })
          .optional(),
        /**
         * 命令沙箱（M5-04，ADR-0034）：本会话的策略、能力探测结果与不可用时的行为。省略时（旧主进程）
         * 宿主不启用命令沙箱，保持现有执行语义。沙箱只覆盖 `run_command` 与 `start_command` 启动的进程树。
         */
        sandbox: z
          .object({
            policy: SandboxPolicy,
            capability: SandboxCapability,
            unavailable: SandboxUnavailableBehavior,
            /** 实验性 AppContainer 配置名（稳定哈希，不含项目路径与用户名）；默认档位不使用。 */
            appContainerName: z.string().min(1).optional(),
          })
          .optional(),
        /**
         * 这一轮可用的 MCP 工具（M3-09）。宿主只拿到定义；调用经 `host.mcp.call` 交给主进程，
         * 由主进程的连接管理器执行。
         */
        mcpTools: z.array(McpToolExposure).optional(),
      }),
      result: z.object({}),
    },
    /**
     * 用户输入已由主进程落库为 message.user，messageId 与之对应。
     * `mode: 'plan'`（M3-05）时这一轮只读，并多一个 `propose_plan`。
     * `plan` 是正在执行的已批准计划，有它时提供 `update_plan_step`。
     */
    'host.prompt': {
      params: z.object({
        messageId: Id,
        content: z.array(ContentPart).min(1),
        mode: PromptMode.optional(),
        plan: ActivePlan.optional(),
      }),
      result: z.object({}),
    },
    /** 立刻压缩上下文（M3-03）。轮次还在跑时排到它结束之后。 */
    'host.compact': {
      params: z.object({}),
      result: z.object({ compacted: z.boolean() }),
    },
    'host.abort': {
      params: z.object({ reason: z.enum(['user', 'shutdown']) }),
      result: z.object({}),
    },
    'host.shutdown': {
      params: z.object({}),
      result: z.object({}),
    },
    /**
     * 替换宿主的权限规则（M1-11a）：切换权限模式、修改规则后，运行中的宿主用新的规则判定之后的调用。
     * 内容与 `host.init.permissionRules` 相同。
     */
    'host.permissions.update': {
      params: z.object({ rules: z.array(PermissionRule) }),
      result: z.object({}),
    },
    /** 心跳：主进程定期请求，超时视为宿主卡死（架构 §21）。 */
    'host.heartbeat': {
      params: z.object({}),
      result: z.object({ ts: Timestamp }),
    },
  },
  events: {
    'host.event': z.object({ event: UnsequencedEventSchema }),
    /**
     * 未决审批被宿主取消（M1-11a）：用户停止、轮次中止或宿主退出前。主进程收起审批卡片，并以错误结束
     * 对应的 `host.approval.request`（宿主已不再等待它的结果）。
     */
    'host.approval.cancelled': z.object({ approvalId: Id }),
  },
})

export const MainForHost = defineSide({
  requests: {
    /**
     * 请求用户审批一次工具调用（M1-11a）：等到用户决定或宿主取消（`host.approval.cancelled`）才返回，
     * 没有超时。会话与运行由连接确定。
     */
    'host.approval.request': {
      params: HostApprovalRequest,
      result: HostApprovalResponse,
    },
    /**
     * 记录一次文件改动（M1-08b）：主进程把前后内容写入 blob 存储、写入改动记录，返回记录 id。
     * 会话与运行由连接确定。宿主随后发出 `file.changed`。
     */
    'changes.record': {
      params: FileChangeInput,
      result: z.object({ changeId: Id }),
    },
    /**
     * 本轮要放进系统提示词的项目说明（M3-02）。会话由连接确定。没有文件、或项目关闭了读取时，
     * 没有 `text`。主进程每轮读一次，所以改开关后下一轮就生效。
     */
    'host.agentsMd': {
      params: z.object({}),
      result: z.object({
        text: z.string().min(1).optional(),
        context: z.object({ agentsMd: AgentsMdContext }).optional(),
      }),
    },
    /**
     * 把更早的对话总结成一段（M3-03）。会话由连接确定。没有可用模型或总结失败时没有 `text`，
     * 宿主改为丢掉最早的工具输出。
     */
    'host.summarize': {
      params: z.object({ transcript: z.string().min(1) }),
      result: z.object({ text: z.string().min(1).optional() }),
    },
    /**
     * 当前会话要点（M3-04）。会话由连接确定。没有要点时没有 `text`。
     * 宿主在每次调用模型前读取，所以用户改完后下一轮就能看到。
     */
    'host.sessionBrief': {
      params: z.object({}),
      result: z.object({ text: z.string().min(1).optional() }),
    },
    /**
     * 本轮可以交给模型的技能（M3-07）。会话由连接确定。只含已启用、且没有被同名技能盖住的。
     * `pinned` 的正文由宿主放进系统提示词；其余只放索引，模型用 `load_skill` 读取。
     */
    'host.skills': {
      params: z.object({}),
      result: z.object({ skills: z.array(SkillCatalogEntry) }),
    },
    /**
     * 执行一个 MCP 工具（M3-09）。服务与工具由 `host.init.mcpTools` 给出；主进程校验服务仍然可用。
     * 结果已转成文本，并按工具输出预算截断。
     */
    'host.mcp.call': {
      params: z.object({
        serverId: Id,
        toolName: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
        maxOutputTokens: z.number().int().positive().optional(),
      }),
      result: z.object({ text: z.string(), isError: z.boolean() }),
    },
    /**
     * 解析一次委派的目标（M4-02，设计 §5）：主进程给出目标 Agent 的已发布定义、模型、凭据、模型配置、
     * 权限规则、Skills、MCP 工具与工作区方式。凭据只经这条私有接口传回宿主内存，不写入事件与日志。
     * 目标不存在或未发布时以 `delegation.agent_not_published` 拒绝。
     */
    'host.delegate': {
      params: z.object({ agent: Id }),
      result: z.object({
        definition: AgentDefinition,
        model: ModelRef,
        credential: z.object({ apiKey: z.string().min(1) }).optional(),
        modelConfig: HostModelConfig.optional(),
        permissionRules: z.array(PermissionRule),
        skills: z.array(SkillCatalogEntry),
        mcpTools: z.array(McpToolExposure),
        workspace: z.enum(['shared', 'isolated']),
      }),
    },
    /**
     * 列出可委派目标的名称与描述（M4-02）：宿主用它在 `delegate` 工具说明里帮助模型选择目标。
     * 只返回已发布的 Agent；省略或没有结果时工具说明只列 id。
     */
    'host.delegate.targets': {
      params: z.object({ agents: z.array(Id).max(50) }),
      result: z.object({
        targets: z.array(
          z.object({
            id: Id,
            name: z.string().min(1),
            description: z.string(),
            /** 目标 Agent 的权限模式（M4-03）：宿主据此决定委派前是否需要审批。 */
            permissions: PermissionMode,
          }),
        ),
      }),
    },
    /**
     * 创建隔离工作区（M4-08）：以父工作区的检查点提交为基线，在主进程的应用数据目录中创建工作树或
     * 导出副本。宿主在委派写入类子运行前调用；失败时宿主回退到共享工作区。
     */
    'host.workspace.create': {
      params: z.object({
        projectPath: z.string().min(1),
        baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        sessionId: Id,
        runId: Id,
        /** 嵌套委派使用子运行自己的影子仓库；省略时主进程按会话解析项目影子仓库。 */
        gitDir: z.string().min(1).optional(),
      }),
      result: IsolatedWorkspaceInfo,
    },
    /** 清理隔离工作区（M4-08）：子运行结束、改动集处理完后调用。 */
    'host.workspace.cleanup': {
      params: z.object({ runId: Id }),
      result: z.object({ cleaned: z.boolean() }),
    },
    /**
     * 计算隔离工作区中的改动集（M4-09，ADR-0031）：以工作区创建时的基线提交为准，与隔离目录
     * 当前内容比较，生成文件级 diff 并写入 `change_sets`。会话由连接确定。
     * 必须在清理工作区之前调用；`parentRunId` 是发起委派的运行（事件与界面按它归属）。
     */
    'host.changeset.create': {
      params: z.object({
        runId: Id,
        parentRunId: Id.optional(),
      }),
      result: z.object({
        changeSetId: Id,
        files: z.array(
          z.object({
            path: z.string().min(1),
            added: z.number().int().nonnegative(),
            removed: z.number().int().nonnegative(),
          }),
        ),
      }),
    },
    'host.command.start': {
      params: z.object({
        runId: Id,
        command: z.string().min(1).max(20_000),
        cwd: z.string().min(1),
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
        /** 这次后台命令使用的沙箱策略（M5-04）；省略时主进程按设置解析。 */
        sandbox: SandboxPolicy.optional(),
      }),
      result: BackgroundCommand,
    },
    /**
     * 记录一次模型调用前的上下文快照（M4-04，ADR-0033）。会话由连接确定；主进程脱敏、截断后
     * 写入 `run_snapshots`，每个运行保留最近 20 份。
     */
    'host.snapshot': {
      params: RunSnapshotInput,
      result: z.object({}),
    },
  },
  events: {},
})
