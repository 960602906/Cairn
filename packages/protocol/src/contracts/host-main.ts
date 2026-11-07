/**
 * 主进程 ↔ Agent 宿主进程的接口（架构 §15.3，ADR-0003）。
 * 主进程控制宿主（请求），宿主把运行时事件推给主进程（事件，无 seq，由主进程分配）。
 */
import { z } from 'zod'
import {
  AgentDefinitionRef,
  CanonicalMessage,
  ContentPart,
  Id,
  ModelRef,
  RunLimits,
  RunMode,
  RunState,
  Timestamp,
} from '../common.js'
import { FileChangeInput } from '../changes.js'
import { AgentsMdContext, ApprovalDecision, UnsequencedEventSchema } from '../events.js'
import { PermissionRule, ToolCategory } from '../permissions.js'
import { BaseUrl, ModelCompat, ModelProfile, ProviderKind } from '../providers.js'
import { defineSide } from '../rpc.js'

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
 * 宿主发起的审批请求（M1-11a，架构 §10.4）：界面显示工具、参数、预览与判定理由。
 * `kind`：`tool` 为权限判定需要审批；`no_checkpoint` 为检查点创建失败，确认是否不带检查点继续。
 */
export const HostApprovalRequest = z.object({
  approvalId: Id,
  toolCallId: Id,
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
        agent: AgentDefinitionRef,
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
      }),
      result: z.object({}),
    },
    /** 用户输入已由主进程落库为 message.user，messageId 与之对应。 */
    'host.prompt': {
      params: z.object({ messageId: Id, content: z.array(ContentPart).min(1) }),
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
  },
  events: {},
})
