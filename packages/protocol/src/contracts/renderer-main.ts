/**
 * 渲染进程 ↔ 主进程的接口（架构 §15.2）。
 * 渲染进程只调用主进程的请求、接收主进程的事件；渲染进程自身不提供接口。
 */
import { z } from 'zod'
import { FileChangeSummary, FileContent } from '../changes.js'
import { CheckpointId, CheckpointRestorePlan, CheckpointSummary } from '../checkpoints.js'
import { ContentPart, Id, ModelRef, Timestamp } from '../common.js'
import { ApprovalDecision, EventEnvelopeSchema } from '../events.js'
import { PermissionMode } from '../permissions.js'
import { CONFIG_ID_PATTERN, ProviderConfigList } from '../providers.js'
import { defineSide } from '../rpc.js'
import { HostApprovalRequest } from './host-main.js'

/** 会话在列表中显示的状态（由运行状态汇总得出）。 */
export const SessionStatus = z.enum([
  'idle',
  'running',
  'waiting_approval',
  'failed',
  'interrupted',
  'crashed',
  'archived',
])
export type SessionStatus = z.infer<typeof SessionStatus>

export const SessionSummary = z.object({
  sessionId: Id,
  title: z.string(),
  projectPath: z.string(),
  status: SessionStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** 会话使用的模型（M1-04a）；之前创建的会话没有，使用默认模型。 */
  model: ModelRef.optional(),
})
export type SessionSummary = z.infer<typeof SessionSummary>

/** 已打开过的项目（M1-16a）。 */
export const ProjectSummary = z.object({
  projectId: Id,
  name: z.string(),
  /** 项目目录的绝对路径。 */
  path: z.string().min(1),
  createdAt: Timestamp,
})
export type ProjectSummary = z.infer<typeof ProjectSummary>

/** 会话标题的长度上限（字符，M2-02）。 */
export const SESSION_TITLE_MAX_LENGTH = 200

/** 自定义说明的长度上限（字符）。 */
export const INSTRUCTIONS_MAX_LENGTH = 10_000

/** 界面语言（ADR-0013）；与 `@cairn/i18n` 的 `SUPPORTED_LOCALES` 一致。 */
export const Locale = z.enum(['zh-CN', 'en-US'])
export type Locale = z.infer<typeof Locale>

/** 界面主题（M2-01，视觉规范 §3）：跟随系统、浅色或深色。 */
export const Theme = z.enum(['system', 'light', 'dark'])
export type Theme = z.infer<typeof Theme>

/**
 * 应用设置。之后的设置项只能以可选字段向后兼容地追加。
 * - `providers`：模型提供方配置（M1-04a），不含 Key；
 * - `defaultModel`：新会话默认使用的模型，指向 `providers` 中的某个模型；没有设置时不出现。
 * - `permissionMode`：权限模式（M1-10c，架构 §10.3），即使用哪组预设规则；没有设置时不出现，按“询问”。
 * - `instructions`：用户的自定义说明（M1-13b，架构 §13），加入每个会话的系统提示词；没有设置时不出现。
 * - `theme`：界面主题（M2-01）；没有设置时不出现，按“跟随系统”。
 */
export const Settings = z.object({
  locale: Locale,
  providers: ProviderConfigList,
  defaultModel: ModelRef.optional(),
  permissionMode: PermissionMode.optional(),
  instructions: z.string().min(1).max(INSTRUCTIONS_MAX_LENGTH).optional(),
  theme: Theme.optional(),
})
export type Settings = z.infer<typeof Settings>

/**
 * 设置的更新：只改给出的项。`providers` 整体替换；`defaultModel` 为 null 时清除。
 * 默认模型必须是（更新后的）提供方列表中的模型；删除默认模型所在的提供方或模型时，默认模型一并清除。
 */
export const SettingsPatch = z.object({
  locale: Locale.optional(),
  providers: ProviderConfigList.optional(),
  defaultModel: ModelRef.nullable().optional(),
  permissionMode: PermissionMode.optional(),
  /** 空字符串或 null 清除自定义说明。 */
  instructions: z.string().max(INSTRUCTIONS_MAX_LENGTH).nullable().optional(),
  theme: Theme.optional(),
})
export type SettingsPatch = z.infer<typeof SettingsPatch>

/** 等待用户决定的审批（M1-11b）：内容与宿主的 `host.approval.request` 相同。 */
export const PendingApproval = HostApprovalRequest
export type PendingApproval = HostApprovalRequest

/** 拒绝时附加的说明的长度上限（交给模型）。 */
export const APPROVAL_FEEDBACK_MAX_LENGTH = 2000

/** 凭据引用（ADR-0010）：字母、数字、`.`、`_`、`-`，1～128 个字符（例如提供方 id）。 */
export const CREDENTIAL_REF_PATTERN = CONFIG_ID_PATTERN
export const CredentialRef = z.string().regex(CREDENTIAL_REF_PATTERN)

/** seq 从 1 开始；afterSeq 为 0 表示从头读取。 */
const Seq = z.number().int().nonnegative()

export const MainForRenderer = defineSide({
  requests: {
    'session.create': {
      /** `model` 省略时使用设置中的默认模型；给出时必须是已配置的模型。 */
      params: z.object({
        projectPath: z.string().min(1),
        title: z.string().optional(),
        model: ModelRef.optional(),
      }),
      result: z.object({ sessionId: Id }),
    },
    /** 已打开过的项目，按打开时间倒序（M1-16a）。 */
    'project.list': {
      params: z.object({}),
      result: z.object({ projects: z.array(ProjectSummary) }),
    },
    /**
     * 用系统的选择文件夹对话框打开项目（M1-16a）：记录并返回所选目录的项目（已打开过的返回原有记录）。
     * 用户取消时没有 `project`。
     */
    'project.open': {
      params: z.object({}),
      result: z.object({ project: ProjectSummary.optional() }),
    },
    'session.list': {
      params: z.object({ includeArchived: z.boolean().optional() }),
      result: z.object({ sessions: z.array(SessionSummary) }),
    },
    'session.prompt': {
      params: z.object({ sessionId: Id, content: z.array(ContentPart).min(1) }),
      result: z.object({ messageId: Id }),
    },
    'session.abort': {
      params: z.object({ sessionId: Id }),
      result: z.object({}),
    },
    /** 重命名会话（M2-02），写入 `session.renamed`。标题去掉首尾空白，可以为空（显示为“未命名会话”）。 */
    'session.rename': {
      params: z.object({ sessionId: Id, title: z.string().max(SESSION_TITLE_MAX_LENGTH) }),
      result: z.object({}),
    },
    /**
     * 更换会话的模型（M2-04），写入 `session.model.changed`，从下一轮起生效（正在进行的一轮不受影响）。
     * 模型必须已配置，否则报 `session.unknown_model`。
     */
    'session.setModel': {
      params: z.object({ sessionId: Id, model: ModelRef }),
      result: z.object({}),
    },
    /**
     * 删除（归档）会话（M2-02），写入 `session.archived`：不再出现在列表中，事件与改动记录保留。
     * 会话正在运行时报 `run.busy`。
     */
    'session.archive': {
      params: z.object({ sessionId: Id }),
      result: z.object({}),
    },
    /**
     * 订阅会话事件：先返回 afterSeq 之后的持久化事件（补发），
     * 之后的事件通过 session.events 推送，二者之间无重复、无遗漏（架构 §7.3）。
     */
    'session.subscribe': {
      params: z.object({ sessionId: Id, afterSeq: Seq }),
      result: z.object({ events: z.array(EventEnvelopeSchema), lastSeq: Seq }),
    },
    'session.unsubscribe': {
      params: z.object({ sessionId: Id }),
      result: z.object({}),
    },
    /** 当前设置；没有保存过的项取默认值（语言按系统语言检测）。 */
    'settings.get': {
      params: z.object({}),
      result: Settings,
    },
    /** 只更新给出的设置项，返回更新后的全部设置。 */
    'settings.update': {
      params: SettingsPatch,
      result: Settings,
    },
    /**
     * 凭据（ADR-0010，M1-03）：界面只能写入、删除与查询是否已配置，没有读出明文的接口。
     * Key 由主进程加密保存（首尾空白会被去掉，最长 4096 个字符）。
     */
    'credentials.set': {
      params: z.object({ ref: CredentialRef, secret: z.string().min(1).max(8192) }),
      result: z.object({}),
    },
    'credentials.delete': {
      params: z.object({ ref: CredentialRef }),
      result: z.object({ deleted: z.boolean() }),
    },
    /** `available`：系统加密是否可用；不可用时无法保存（Linux 无密钥环）。 */
    'credentials.status': {
      params: z.object({ ref: CredentialRef }),
      result: z.object({ configured: z.boolean(), available: z.boolean() }),
    },
    /** 会话中等待用户决定的审批（M1-11b），按请求顺序。界面收到 `approval.*` 事件后重新读取。 */
    'approval.pending': {
      params: z.object({ sessionId: Id }),
      result: z.object({ approvals: z.array(PendingApproval) }),
    },
    /**
     * 决定一个审批（M1-11b，架构 §10.4）：允许一次、本会话 / 本项目始终允许（保存生成的规则）、拒绝
     * （`feedback` 交给模型）。审批已结束或不存在时报 `approval.not_found`。
     */
    'approval.resolve': {
      params: z.object({
        sessionId: Id,
        approvalId: Id,
        decision: ApprovalDecision,
        feedback: z.string().max(APPROVAL_FEEDBACK_MAX_LENGTH).optional(),
      }),
      result: z.object({}),
    },
    /** 会话的文件改动记录（M1-08b），按发生顺序。 */
    'changes.list': {
      params: z.object({ sessionId: Id }),
      result: z.object({ changes: z.array(FileChangeSummary) }),
    },
    /**
     * 整文件撤销（M1-08b；按块撤销在 M3）：按与发生相反的顺序把文件恢复为改动前的内容。
     * 会话正在运行时拒绝；文件在改动之后又被修改过（与记录的内容不一致）时整体拒绝，不做部分撤销。
     * 返回撤销产生的改动记录（`revertOf` 指向被撤销的改动）。
     */
    'changes.revert': {
      params: z.object({ sessionId: Id, changeIds: z.array(Id).min(1).max(1000) }),
      result: z.object({ changes: z.array(FileChangeSummary) }),
    },
    /**
     * 一次改动前后的内容（M2-07，界面据此显示 diff）：`create` 没有 `before`，`delete` 没有 `after`。
     * 二进制文件与过大的文本只返回大小。改动不属于该会话时报 `changes.not_found`，内容在 blob 存储中
     * 找不到时报 `changes.content_missing`。
     */
    'changes.content': {
      params: z.object({ sessionId: Id, changeId: Id }),
      result: z.object({ before: FileContent.optional(), after: FileContent.optional() }),
    },
    /** 会话的检查点（M1-12c），按创建顺序；会话所属项目没有影子仓库时为空。 */
    'checkpoint.list': {
      params: z.object({ sessionId: Id }),
      result: z.object({ checkpoints: z.array(CheckpointSummary) }),
    },
    /**
     * 预览恢复到会话的某个检查点（M1-12c）：先建检查点，返回恢复将改动的文件，不改动工作区。
     * 检查点不属于这个会话时报 `checkpoint.not_found`；同一项目有会话正在运行时报 `run.busy`。
     */
    'checkpoint.preview': {
      params: z.object({ sessionId: Id, checkpointId: CheckpointId }),
      result: CheckpointRestorePlan,
    },
    /**
     * 把工作区恢复到会话的某个检查点（M1-12c，架构 §11.3）：先建检查点（`checkpoint.created`，原因
     * `before_restore`），再改写工作区并写入 `checkpoint.restored`。对话不截断（M1 不提供）。
     * 错误与 `checkpoint.preview` 相同；恢复期间会话不接受输入。
     */
    'checkpoint.restore': {
      params: z.object({ sessionId: Id, checkpointId: CheckpointId }),
      result: CheckpointRestorePlan,
    },
  },
  events: {
    /** 实时事件推送；增量事件在主进程合并后按帧率批量推送（架构 §22）。 */
    'session.events': z.object({ sessionId: Id, events: z.array(EventEnvelopeSchema) }),
    /**
     * 会话的未决审批有变化（新请求、已决定或被取消，M1-11b）；界面重新读取 `approval.pending`。
     * 只推送给订阅了该会话的窗口。审批请求在 `approval.requested` 事件之后才登记，因此不能只靠事件。
     */
    'approval.changed': z.object({ sessionId: Id }),
  },
})

export const RendererForMain = defineSide({ requests: {}, events: {} })

/**
 * 已规划、尚未实现的接口名（架构 §15.2）。实现时从这里移入 MainForRenderer。
 */
export const RESERVED_RENDERER_MAIN_METHODS = [
  'session.rename',
  'session.archive',
  'provider.test',
] as const
