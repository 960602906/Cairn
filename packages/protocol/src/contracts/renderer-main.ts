/**
 * 渲染进程 ↔ 主进程的接口（架构 §15.2）。
 * 渲染进程只调用主进程的请求、接收主进程的事件；渲染进程自身不提供接口。
 */
import { z } from 'zod'
import { AppInfo, AppLicenses } from '../app-info.js'
import { FileChangeSummary, FileContent } from '../changes.js'
import { ActivityDecision, ActivityListResult } from '../activity.js'
import { CheckpointId, CheckpointRestorePlan, CheckpointSummary } from '../checkpoints.js'
import { BackgroundCommand, BackgroundCommandOutput } from '../commands.js'
import {
  DiagnosticsExportInput,
  DiagnosticsExportResult,
  DiagnosticsSummary,
} from '../diagnostics.js'
import { RunInspectResult } from '../inspect.js'
import { AgentDefinitionRef, ContentPart, ErrorInfo, Id, ModelRef, Timestamp } from '../common.js'
import {
  AgentDetail,
  AgentDiff,
  AgentDiffEndpoint,
  AgentDraftInput,
  AgentEffectiveConfig,
  AgentSource,
  AgentStatus,
  AgentSummary,
  AgentVersionSummary,
  LocalizedText,
} from '../agents.js'
import { ApprovalDecision, EventEnvelopeSchema } from '../events.js'
import {
  ChangeSetApplyResult,
  ChangeSetConflictResolution,
  ChangeSetInfo,
  ChangeSetSummary,
} from '../change-sets.js'
import { PLAN_FEEDBACK_MAX, PlanStep, PromptMode } from '../plan.js'
import { SkillDetail, SkillInstallSource, SkillSource, SkillSummary } from '../skills.js'
import { HubMcpCard, HubSkillCard } from '../hub.js'
import {
  McpLogEntry,
  McpServerDetail,
  McpServerInput,
  McpServerSummary,
  McpStatusEvent,
  McpToolSummary,
} from '../mcp.js'
import { PermissionEffect, PermissionMode, PermissionRule, ToolCategory } from '../permissions.js'
import {
  SandboxDefaultProfile,
  SandboxNetwork,
  SandboxStatus,
  SandboxUnavailableBehavior,
} from '../sandbox.js'
import { CONFIG_ID_PATTERN, ProviderConfig, ProviderConfigList, RemoteModel } from '../providers.js'
import { defineSide } from '../rpc.js'
import { HostApprovalRequest, ShellPreference } from './host-main.js'
import { TrialStarted, TrialSummary } from '../trial.js'
import { UpdateChannel, UpdateStatus } from '../update.js'

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

/** 项目名称的长度上限（字符，M3-02）。 */
export const PROJECT_NAME_MAX_LENGTH = 200

/**
 * 已打开过的项目（M1-16a，M3-02 补上会话数、最近使用和两个开关）。
 * 后加的字段都是可选的：省略 `readAgentsMd` 表示读取，省略 `enableProjectSkills` 表示开启（项目内技能默认读取），
 * 省略 `sessionCount` 表示 0。
 */
export const ProjectSummary = z.object({
  projectId: Id,
  name: z.string(),
  /** 项目目录的绝对路径。 */
  path: z.string().min(1),
  createdAt: Timestamp,
  /** 未归档的会话数。 */
  sessionCount: z.number().int().nonnegative().optional(),
  /** 最近一个会话的更新时间；还没有会话时不出现。 */
  lastUsedAt: Timestamp.optional(),
  /** 是否在每轮开始时读取 `AGENTS.md`。省略表示读取。 */
  readAgentsMd: z.boolean().optional(),
  /** 是否启用项目内 Skills（M3-07 起生效）。省略表示关闭。 */
  enableProjectSkills: z.boolean().optional(),
  /** 是否置顶（目录功能同步）。省略表示未置顶。 */
  isPinned: z.boolean().optional(),
  /** 置顶时间；未置顶时不出现。 */
  pinnedAt: Timestamp.optional(),
  /** 归档时间；未归档时不出现。 */
  archivedAt: Timestamp.optional(),
})
export type ProjectSummary = z.infer<typeof ProjectSummary>

/** 文件树节点类型（目录功能同步）。 */
export const FileTreeEntryKind = z.enum(['file', 'dir'])
export type FileTreeEntryKind = z.infer<typeof FileTreeEntryKind>

/** 文件树的一行；`path` 是相对项目根目录的路径，使用 `/` 分隔。 */
export const FileTreeEntry = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: FileTreeEntryKind,
  hidden: z.boolean(),
})
export type FileTreeEntry = z.infer<typeof FileTreeEntry>

/** 会话标题的长度上限（字符，M2-02）。 */
export const SESSION_TITLE_MAX_LENGTH = 200

/** 自定义说明的长度上限（字符）。 */
export const INSTRUCTIONS_MAX_LENGTH = 10_000

/** 界面语言（ADR-0013）；与 `@cairn/i18n` 的 `SUPPORTED_LOCALES` 一致。 */
export const Locale = z.enum(['zh-CN', 'en-US'])
export type Locale = z.infer<typeof Locale>

/**
 * 界面主题（视觉规范 §3）。五套内置配色 + 跟随系统：
 * - `bluestone` 青石（深色，青绿，默认）
 * - `obsidian` 黑曜（深色，信号橙）、`slate` 板岩（深色，鸢尾）
 * - `paper` 纸面（浅色，酒红）、`tundra` 苔原（浅色，苔绿）
 * 旧版本保存的 `light` / `dark` / `graphite` 仍然可读，读取时分别归到 `tundra` / `obsidian` / `obsidian`。
 */
export const Theme = z.enum([
  'system',
  'bluestone',
  'obsidian',
  'tundra',
  'paper',
  'slate',
  'light',
  'dark',
  'graphite',
])
export type Theme = z.infer<typeof Theme>

/**
 * 应用设置。之后的设置项只能以可选字段向后兼容地追加。
 * - `providers`：模型提供方配置（M1-04a），不含 Key；
 * - `defaultModel`：新会话默认使用的模型，指向 `providers` 中的某个模型；没有设置时不出现。
 * - `auxiliaryModel`：辅助模型（M3-01），用于标题、会话要点、压缩摘要；没有设置时不出现，改用会话的主模型。
 * - `permissionMode`：权限模式（M1-10c，架构 §10.3），即使用哪组预设规则；没有设置时不出现，按“询问”。
 * - `instructions`：用户的自定义说明（M1-13b，架构 §13），加入每个会话的系统提示词；没有设置时不出现。
 * - `theme`：界面主题（M2-01）；没有设置时不出现，按“跟随系统”。
 * - `shell`：命令执行使用的 shell（M2-09）；没有设置时不出现，按 `auto`。
 * - `sessionBrief`：是否在每轮结束后自动更新会话要点（M3-04）。没有设置时不出现，按开。
 * - `activityNotifications`：是否发送活动中心系统通知（M4-06）。没有设置时不出现，按开。
 */
export const Settings = z.object({
  locale: Locale,
  providers: ProviderConfigList,
  defaultModel: ModelRef.optional(),
  auxiliaryModel: ModelRef.optional(),
  permissionMode: PermissionMode.optional(),
  instructions: z.string().min(1).max(INSTRUCTIONS_MAX_LENGTH).optional(),
  theme: Theme.optional(),
  shell: ShellPreference.optional(),
  sessionBrief: z.boolean().optional(),
  activityNotifications: z.boolean().optional(),
  /**
   * 默认沙箱档位（M5-04）：只允许 `read-only` 与 `workspace-write`；`danger-full-access` 不能保存为默认值。
   * 没有设置时不出现，按 `workspace-write`。
   */
  sandboxProfile: SandboxDefaultProfile.optional(),
  /** 网络策略（M5-04）。没有设置时不出现，按 `none`。 */
  sandboxNetwork: SandboxNetwork.optional(),
  /** 沙箱不可用时的行为（M5-04）。没有设置时不出现，按失败关闭。 */
  sandboxUnavailable: SandboxUnavailableBehavior.optional(),
  /**
   * 是否自动检查更新（M5-06）。没有设置时不出现，按开。
   */
  updateAutoCheck: z.boolean().optional(),
  /**
   * 更新通道（M5-06）。没有设置时不出现，使用构建通道；构建注入 `CAIRN_UPDATE_CHANNEL` 时以构建为准。
   */
  updateChannel: UpdateChannel.optional(),
  /** 上次检查更新的时间（M5-06）；没有检查过时不出现。 */
  updateLastCheckedAt: Timestamp.optional(),
  /** 用户选择跳过的版本（M5-06）；没有跳过时不出现。 */
  updateSkippedVersion: z.string().min(1).max(64).optional(),
})
export type Settings = z.infer<typeof Settings>

/**
 * 设置的更新：只改给出的项。`providers` 整体替换；`defaultModel`、`auxiliaryModel` 为 null 时清除。
 * 默认模型与辅助模型必须是（更新后的）提供方列表中的模型；删除其所在的提供方或模型时一并清除。
 */
export const SettingsPatch = z.object({
  locale: Locale.optional(),
  providers: ProviderConfigList.optional(),
  defaultModel: ModelRef.nullable().optional(),
  auxiliaryModel: ModelRef.nullable().optional(),
  permissionMode: PermissionMode.optional(),
  /** 空字符串或 null 清除自定义说明。 */
  instructions: z.string().max(INSTRUCTIONS_MAX_LENGTH).nullable().optional(),
  theme: Theme.optional(),
  shell: ShellPreference.optional(),
  /** false 关闭自动更新；true 重新打开（保存时省略，与没设置一样）。 */
  sessionBrief: z.boolean().optional(),
  /** false 关闭活动中心通知；true 重新打开（保存时省略，与没设置一样）。 */
  activityNotifications: z.boolean().optional(),
  sandboxProfile: SandboxDefaultProfile.optional(),
  sandboxNetwork: SandboxNetwork.optional(),
  sandboxUnavailable: SandboxUnavailableBehavior.optional(),
  /** false 关闭自动检查；true 恢复默认（保存时省略）。 */
  updateAutoCheck: z.boolean().optional(),
  updateChannel: UpdateChannel.optional(),
  /** 检查完成后由更新服务写入。 */
  updateLastCheckedAt: Timestamp.optional(),
  /** null 清除跳过的版本。 */
  updateSkippedVersion: z.string().min(1).max(64).nullable().optional(),
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

/**
 * 保存的一条权限规则（M2-11）：全局规则没有 `projectId`，项目规则带所属项目。会话范围的规则只在会话中
 * 生效，设置页不列出。
 */
export const PermissionRuleEntry = z.object({
  rule: PermissionRule,
  projectId: Id.optional(),
  createdAt: Timestamp,
})
export type PermissionRuleEntry = z.infer<typeof PermissionRuleEntry>

/** seq 从 1 开始；afterSeq 为 0 表示从头读取。 */
const Seq = z.number().int().nonnegative()

export const MainForRenderer = defineSide({
  requests: {
    /** 应用版本、通道与构建信息（M5-01）。 */
    'app.info': {
      params: z.object({}),
      result: AppInfo,
    },
    /** 随包的第三方许可声明（M5-07）：关于页的许可入口按需读取。 */
    'app.licenses': {
      params: z.object({}),
      result: AppLicenses,
    },
    /** 命令沙箱的当前配置与能力（M5-05）：设置页与诊断入口使用。 */
    'sandbox.status': {
      params: z.object({}),
      result: SandboxStatus,
    },
    /** 自动更新的当前状态（M5-06）。 */
    'update.status': {
      params: z.object({}),
      result: UpdateStatus,
    },
    /**
     * 检查更新（M5-06）：`force` 为 true 时忽略用户跳过的版本与自动检查开关。
     * 更新被禁用时返回 `phase: 'disabled'`，不抛错。
     */
    'update.check': {
      params: z.object({ force: z.boolean().optional() }),
      result: UpdateStatus,
    },
    /** 下载可用更新（M5-06）：校验失败会删除临时包并返回错误状态。 */
    'update.download': {
      params: z.object({}),
      result: UpdateStatus,
    },
    /**
     * 安装已下载的更新并重启（M5-06）。有运行中会话、待审批或检查点恢复时拒绝；
     * 安装前备份数据库、设置与凭据元数据。
     */
    'update.install': {
      params: z.object({}),
      result: UpdateStatus,
    },
    /** 取消正在进行的下载（M5-06）；其他状态下不改变状态。 */
    'update.cancel': {
      params: z.object({}),
      result: UpdateStatus,
    },
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
    /**
     * 修改项目（M3-02）：名称、是否读取 `AGENTS.md`、是否启用项目内 Skills。至少给出一项。
     * 名称去掉首尾空白后不能为空。项目不在列表中时报 `project.not_found`。
     */
    'project.update': {
      params: z
        .object({
          projectId: Id,
          name: z.string().max(PROJECT_NAME_MAX_LENGTH).optional(),
          readAgentsMd: z.boolean().optional(),
          enableProjectSkills: z.boolean().optional(),
          pinned: z.boolean().optional(),
          archived: z.boolean().optional(),
        })
        .refine(
          (patch) =>
            patch.name !== undefined ||
            patch.readAgentsMd !== undefined ||
            patch.enableProjectSkills !== undefined ||
            patch.pinned !== undefined ||
            patch.archived !== undefined,
        ),
      result: ProjectSummary,
    },
    /**
     * 从列表移除项目（M3-02）：只去掉这条记录，不删除目录，也不删除已有会话。
     * 再次打开同一目录会恢复原来的记录和开关。
     */
    'project.remove': {
      params: z.object({ projectId: Id }),
      result: z.object({}),
    },
    /**
     * 列出项目内一个目录的直接子项（文件树）。`path` 省略表示项目根目录；
     * `showHidden` 省略时隐藏以 `.` 开头的条目（`.git` 始终跳过）。
     */
    'fs.list': {
      params: z.object({
        projectId: Id,
        path: z.string().max(4096).optional(),
        showHidden: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      result: z.object({
        entries: z.array(FileTreeEntry),
        truncated: z.boolean(),
      }),
    },
    /** 新建文件或目录；父目录必须已经存在，目标已存在时报 `fs.conflict`。 */
    'fs.create': {
      params: z.object({
        projectId: Id,
        path: z.string().min(1).max(4096),
        kind: FileTreeEntryKind,
      }),
      result: z.object({ path: z.string() }),
    },
    /** 重命名或移动；目标已存在时报 `fs.conflict`。 */
    'fs.rename': {
      params: z.object({
        projectId: Id,
        from: z.string().min(1).max(4096),
        to: z.string().min(1).max(4096),
      }),
      result: z.object({ path: z.string() }),
    },
    /** 递归删除文件或目录；项目根目录不能删除。 */
    'fs.delete': {
      params: z.object({ projectId: Id, path: z.string().min(1).max(4096) }),
      result: z.object({}),
    },
    /** 在系统文件管理器中定位项目或某个条目。 */
    'fs.reveal': {
      params: z.object({
        projectId: Id,
        path: z.string().max(4096).optional(),
      }),
      result: z.object({}),
    },
    'session.list': {
      params: z.object({ includeArchived: z.boolean().optional() }),
      result: z.object({ sessions: z.array(SessionSummary) }),
    },
    /**
     * 发送用户输入。`mode: 'plan'`（M3-05）时这一轮只读并提出计划；省略为正常执行。
     */
    'session.prompt': {
      params: z.object({
        sessionId: Id,
        content: z.array(ContentPart).min(1),
        mode: PromptMode.optional(),
      }),
      result: z.object({ messageId: Id }),
    },
    /**
     * 批准一份待审计划并开始执行（M3-05）。`steps` 是用户改过的步骤标题，按 id 对应；
     * 省略表示不改。随后以正常模式开始新的一轮，输入是批准后的计划。
     */
    'plan.approve': {
      params: z.object({
        sessionId: Id,
        planId: Id,
        steps: z.array(PlanStep).max(20).optional(),
      }),
      result: z.object({ messageId: Id }),
    },
    /** 拒绝当前计划并带着说明重新规划（M3-05）。新的一轮仍是计划模式。 */
    'plan.replan': {
      params: z.object({
        sessionId: Id,
        planId: Id,
        feedback: z.string().trim().min(1).max(PLAN_FEEDBACK_MAX),
      }),
      result: z.object({ messageId: Id }),
    },
    /** 放弃当前计划（M3-05），不再开始新的一轮。 */
    'plan.abandon': {
      params: z.object({ sessionId: Id, planId: Id }),
      result: z.object({}),
    },
    /** 立刻压缩这个会话的上下文（M3-03）。不是一轮对话，不写用户消息。 */
    'session.compact': {
      params: z.object({ sessionId: Id }),
      result: z.object({ compacted: z.boolean() }),
    },
    /**
     * 用户编辑会话要点（M3-04），写入 `session.brief.updated`（`editedBy: user`）。
     * 与当前要点相同时不写事件。空字符串清空。不是一轮对话。
     */
    'session.brief.update': {
      params: z.object({ sessionId: Id, content: z.string().max(16_000) }),
      result: z.object({}),
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
     * 在会话中切换 Agent（M3-11）：新建一个运行（`run.created` 带新的 Agent 引用），之前的对话作为
     * 历史。运行中不能切换。草稿状态的 Agent 不能选用。
     */
    'session.setAgent': {
      params: z.object({ sessionId: Id, agent: AgentDefinitionRef }),
      result: z.object({}),
    },
    /**
     * 用当前草稿开始一次试运行（M4-12）。试运行会话不出现在 `session.list` 中，默认只读；
     * 草稿不需要发布。项目目录不存在时会像普通会话一样创建项目记录。
     */
    'trial.start': {
      params: z.object({
        agentId: Id,
        projectPath: z.string().min(1),
        useAgentPermissions: z.boolean().optional(),
      }),
      result: TrialStarted,
    },
    /** 用当前草稿重新开始试运行，返回新的隐藏会话；旧记录保留到清理或超出保留条数。 */
    'trial.restart': {
      params: z.object({
        sessionId: Id,
        useAgentPermissions: z.boolean().optional(),
      }),
      result: TrialStarted,
    },
    /** 清除一个 Agent 的全部试运行记录（含事件、快照与改动）。 */
    'trial.clear': {
      params: z.object({ agentId: Id }),
      result: z.object({ cleared: z.number().int().nonnegative() }),
    },
    /** 一个 Agent 的试运行历史，按更新时间倒序。 */
    'trial.list': {
      params: z.object({ agentId: Id }),
      result: z.object({ trials: z.array(TrialSummary) }),
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
    /**
     * 运行检查器（M4-04，管理界面 §8.2）：从事件日志投影运行树，并返回最近 20 份上下文快照与
     * 生效设置。省略 `runId` 时使用会话当前的根运行。会话不存在或没有运行时报 `run.not_found`。
     */
    'run.inspect': {
      params: z.object({ sessionId: Id, runId: Id.optional() }),
      result: RunInspectResult,
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
     * 可选的 shell（M2-09）：`auto` 在这台电脑上会选中的 shell（如 `PowerShell 7.5.4`），以及可以设置的选项
     * （Windows 上有 `cmd`）。
     */
    'settings.shell': {
      params: z.object({}),
      result: z.object({
        detected: z.string().min(1),
        options: z.array(ShellPreference).min(1),
      }),
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
      /** `last4`：已保存的 Key 的末 4 位（M2-10，Key 不少于 8 个字符时才有），用于界面辨认。 */
      result: z.object({
        configured: z.boolean(),
        available: z.boolean(),
        last4: z.string().length(4).optional(),
      }),
    },
    /**
     * 测试连接（M2-10）：用这份配置（可以是还没保存的）向模型发一次最小的请求，返回耗时或错误原因。
     * `secret` 是界面上新填、还没保存的 Key；省略时用配置的凭据引用中保存的 Key。
     */
    'provider.test': {
      params: z.object({
        provider: ProviderConfig,
        modelId: Id.max(256),
        secret: z.string().min(1).max(8192).optional(),
      }),
      result: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), latencyMs: z.number().int().nonnegative() }),
        z.object({
          ok: z.literal(false),
          latencyMs: z.number().int().nonnegative().optional(),
          error: ErrorInfo,
        }),
      ]),
    },
    /** 拉取提供方的模型列表（M2-10）；不支持或失败时返回错误，界面允许手动填写。 */
    'provider.models': {
      params: z.object({
        provider: ProviderConfig,
        secret: z.string().min(1).max(8192).optional(),
      }),
      result: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), models: z.array(RemoteModel).max(1000) }),
        z.object({ ok: z.literal(false), error: ErrorInfo }),
      ]),
    },
    /**
     * 保存的全局与项目权限规则（M2-11）：全局在前，项目按打开时间倒序，同一范围内按添加顺序。
     * 权限模式的预设不保存，不在其中。
     */
    'permissions.list': {
      params: z.object({}),
      result: z.object({ rules: z.array(PermissionRuleEntry) }),
    },
    /**
     * 手动添加一条规则（M2-11）：来源必须是 `user`，范围是 `global` 或 `project`（这时给出 `projectId`）。
     * 规则无效时报 `rpc.invalid_params`，项目不存在时报 `storage.not_found`，id 重复时报 `storage.conflict`。
     * 运行中的会话立即改用新规则。
     */
    'permissions.add': {
      params: z.object({ rule: PermissionRule, projectId: Id.optional() }),
      result: PermissionRuleEntry,
    },
    /** 删除一条保存的规则（M2-11，含审批时添加的）；不存在时报 `storage.not_found`。 */
    'permissions.delete': {
      params: z.object({ ruleId: Id }),
      result: z.object({}),
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
    /** 跨会话活动快照（M4-06）：待审批、运行中与最近完成。 */
    'activity.list': {
      params: z.object({}),
      result: ActivityListResult,
    },
    /**
     * 在活动中心就地决定一个审批（M4-06）：按 approvalId 路由到所属会话。审批已结束或不存在时报
     * `approval.not_found`。
     */
    'activity.resolve': {
      params: z.object({
        approvalId: Id,
        decision: ActivityDecision,
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
     * 整文件撤销（M1-08b）：按与发生相反的顺序把文件恢复为改动前的内容。
     * 会话正在运行时拒绝；文件在改动之后又被修改过（与记录的内容不一致）时整体拒绝，不做部分撤销。
     * 返回撤销产生的改动记录（`revertOf` 指向被撤销的改动）。
     */
    'changes.revert': {
      params: z.object({ sessionId: Id, changeIds: z.array(Id).min(1).max(1000) }),
      result: z.object({ changes: z.array(FileChangeSummary) }),
    },
    /**
     * 按块撤销（M3-06）：只撤销这一块。文件里这一块的改后内容必须仍能按上下文行对上（允许整体偏移），
     * 对不上时报 `changes.hunk_conflict`。返回撤销产生的改动记录（`revertOf` 指向原改动）。
     * 每一块都撤销后，原改动状态变为 `reverted`。
     */
    'changes.revertHunk': {
      params: z.object({
        sessionId: Id,
        changeId: Id,
        hunkIndex: z.number().int().nonnegative(),
      }),
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
    /**
     * 会话的改动集（M4-09，ADR-0031）：写入类子运行在隔离工作区中的改动，按创建顺序。
     * 只含汇总，文件明细由 `changeset.get` 读取。
     */
    'changeset.list': {
      params: z.object({ sessionId: Id }),
      result: z.object({ changeSets: z.array(ChangeSetSummary) }),
    },
    /** 一个改动集的详情（含每个文件的 diff）。改动集不属于该会话时报 `changeset.not_found`。 */
    'changeset.get': {
      params: z.object({ sessionId: Id, changeSetId: Id }),
      result: z.object({ changeSet: ChangeSetInfo }),
    },
    /**
     * 合并改动集到主工作区（M4-09）：先建检查点（`before_merge`），再按文件写入。
     * `paths` 省略时合并全部待处理文件；给出时只合并这些路径（按文件接受）。
     * 主工作区在基线之后改过的文件标记为冲突，不写入。合并后恢复检查点即可回退。
     */
    'changeset.apply': {
      params: z.object({
        sessionId: Id,
        changeSetId: Id,
        paths: z.array(z.string().min(1)).max(5000).optional(),
      }),
      result: ChangeSetApplyResult,
    },
    /**
     * 拒绝改动集（M4-09）：`paths` 省略时拒绝整个改动集，给出时只拒绝这些文件。
     * 拒绝不写主工作区；被拒绝的文件保持 `rejected`。
     */
    'changeset.reject': {
      params: z.object({
        sessionId: Id,
        changeSetId: Id,
        paths: z.array(z.string().min(1)).max(5000).optional(),
      }),
      result: z.object({ changeSet: ChangeSetInfo }),
    },
    /**
     * 处理一个冲突文件（M4-09）：保留主工作区（`keep-main`）、采用子运行版本（`take-child`），
     * 或交给用户手动处理（`manual`，不写文件）。
     */
    'changeset.resolveConflict': {
      params: z.object({
        sessionId: Id,
        changeSetId: Id,
        path: z.string().min(1),
        resolution: ChangeSetConflictResolution,
      }),
      result: z.object({ changeSet: ChangeSetInfo }),
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
    /**
     * 已发现的技能（M3-07）。给出 `projectId` 时，在项目开启了项目内技能后一并列出。
     * 项目不存在时报 `project.not_found`。
     */
    'skill.list': {
      params: z.object({ projectId: Id.optional() }),
      result: z.object({ skills: z.array(SkillSummary) }),
    },
    /** 一份技能的原文。找不到时报 `skills.not_found`。项目内技能必须带 `projectId`。 */
    'skill.get': {
      params: z
        .object({
          name: z.string().min(1),
          source: SkillSource,
          projectId: Id.optional(),
        })
        .refine((input) => input.source !== 'project' || input.projectId !== undefined),
      result: SkillDetail,
    },
    /**
     * 用系统对话框选择一份技能的来源（M3-08）：文件夹或 zip。
     * 取消时结果不含 `source`；选择结果直接交给 `skill.install`。
     */
    'skill.pickSource': {
      params: z.object({ kind: z.enum(['directory', 'zip']) }),
      result: z.object({ source: SkillInstallSource.optional() }),
    },
    /**
     * 从本地文件夹或 zip 安装到用户技能目录（M3-07）。
     * `confirm` 省略或为 false 时只返回预览，不写盘；为 true 时安装。
     * 预览包含 `SKILL.md`、文件列表和是否含脚本。同名已安装时报 `skills.duplicate`，
     * 路径逃出技能目录时报 `skills.traversal`。
     */
    'skill.install': {
      params: z.object({
        source: SkillInstallSource,
        confirm: z.boolean().optional(),
      }),
      result: z.object({ installed: z.boolean(), skill: SkillDetail }),
    },
    /**
     * 卸载用户安装的技能（删掉目录）。内置和项目内技能报 `skills.not_uninstallable`。
     * 没有这份已安装技能时报 `skills.not_found`。
     */
    'skill.uninstall': {
      params: z.object({ name: z.string().min(1) }),
      result: z.object({}),
    },
    /**
     * 启用、停用，或改“始终加载”（M3-07）。至少给出 `enabled` 或 `pinned` 一项。
     * 停用的技能不再出现在索引里，也不再挡住同名的低优先级技能。
     */
    'skill.setEnabled': {
      params: z
        .object({
          name: z.string().min(1),
          source: SkillSource,
          projectId: Id.optional(),
          enabled: z.boolean().optional(),
          pinned: z.boolean().optional(),
        })
        .refine(
          (input) =>
            (input.source !== 'project' || input.projectId !== undefined) &&
            (input.enabled !== undefined || input.pinned !== undefined),
        ),
      result: SkillSummary,
    },
    /**
     * 资源市场（M5）：技能来自 ClawHub，只返回卡片；安装用 `skill.installUrl`。
     * `query` 为空时按下载量列出；有查询词时走搜索接口。
     */
    'hub.skills': {
      params: z.object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(48).optional(),
      }),
      result: z.object({ items: z.array(HubSkillCard) }),
    },
    /** 从市场下载 zip 并安装到用户技能目录。只允许 ClawHub 的 https 地址。 */
    'skill.installUrl': {
      params: z.object({ url: z.string().url().max(4096) }),
      result: z.object({ installed: z.boolean(), skill: SkillDetail }),
    },
    /** MCP 市场：官方 MCP Registry 中可远程接入（streamable-http）或本地启动的条目。 */
    'hub.mcp': {
      params: z.object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(48).optional(),
      }),
      result: z.object({ items: z.array(HubMcpCard) }),
    },
    /** 已配置的 MCP 服务（M3-09）：不含环境变量值与令牌。 */
    'mcp.list': {
      params: z.object({}),
      result: z.object({ servers: z.array(McpServerSummary) }),
    },
    /** 一份 MCP 服务的可编辑配置与工具列表（M3-10）。找不到时报 `mcp.not_found`。 */
    'mcp.get': {
      params: z.object({ serverId: Id }),
      result: McpServerDetail,
    },
    /** 添加服务；保存后立即连接（M3-09）。 */
    'mcp.add': {
      params: McpServerInput,
      result: McpServerDetail,
    },
    /** 修改服务；保存后重新连接。`env` 中省略 value 的项保留原值。 */
    'mcp.update': {
      params: z.object({ serverId: Id, server: McpServerInput }),
      result: McpServerDetail,
    },
    /** 删除服务：断开连接并删除它的工具偏好。 */
    'mcp.remove': {
      params: z.object({ serverId: Id }),
      result: z.object({}),
    },
    /** 重新连接（M3-09）：重置重试计数并立即尝试。 */
    'mcp.reconnect': {
      params: z.object({ serverId: Id }),
      result: McpServerSummary,
    },
    /** 启用或停用服务；停用后不再连接，工具也从下一轮起隐藏。 */
    'mcp.setEnabled': {
      params: z.object({ serverId: Id, enabled: z.boolean() }),
      result: McpServerSummary,
    },
    /** 一个服务的工具与各自的类别 / 默认效果（M3-10）。 */
    'mcp.tools': {
      params: z.object({ serverId: Id }),
      result: z.object({ tools: z.array(McpToolSummary) }),
    },
    /** 修改一个工具的类别与默认效果（M3-09）。找不到时报 `mcp.tool_not_found`。 */
    'mcp.setTool': {
      params: z.object({
        serverId: Id,
        name: z.string().min(1),
        category: ToolCategory.optional(),
        effect: PermissionEffect.optional(),
      }),
      result: McpToolSummary,
    },
    /** 最近 200 行连接日志（已脱敏）。 */
    'mcp.logs': {
      params: z.object({ serverId: Id }),
      result: z.object({ logs: z.array(McpLogEntry) }),
    },
    /** 已保存的 Agent（M3-11）：内置的编程助手加上用户与导入的 Agent。 */
    'agent.list': {
      params: z.object({
        includeArchived: z.boolean().optional(),
        source: AgentSource.optional(),
        status: AgentStatus.optional(),
        query: z.string().optional(),
      }),
      result: z.object({ agents: z.array(AgentSummary) }),
    },
    /**
     * 一份 Agent 的当前状态：草稿优先，`published` 是最新的已发布版本。给出 `version` 时返回该版本
     * （`draft` 仍一并返回，便于版本对比）。
     */
    'agent.get': {
      params: z.object({
        agentId: Id,
        version: z.number().int().positive().optional(),
      }),
      result: AgentDetail,
    },
    /** 保存草稿并返回校验结果。内置 Agent 报 `agent.readonly`。 */
    'agent.saveDraft': {
      params: z.object({ definition: AgentDraftInput }),
      result: AgentDetail,
    },
    /** 发布草稿为新版本（版本号加一）。有校验错误时报 `agent.invalid`。 */
    'agent.publish': {
      params: z.object({ agentId: Id }),
      result: AgentDetail,
    },
    /** 复制为新的用户 Agent（草稿）。 */
    'agent.duplicate': {
      params: z.object({ agentId: Id, name: LocalizedText.optional() }),
      result: AgentDetail,
    },
    'agent.archive': {
      params: z.object({ agentId: Id }),
      result: AgentDetail,
    },
    'agent.unarchive': {
      params: z.object({ agentId: Id }),
      result: AgentDetail,
    },
    /** 彻底删除：只允许从未被运行引用过的 Agent，否则报 `agent.in_use`。 */
    'agent.delete': {
      params: z.object({ agentId: Id }),
      result: z.object({}),
    },
    'agent.versions': {
      params: z.object({ agentId: Id }),
      result: z.object({ versions: z.array(AgentVersionSummary) }),
    },
    /** 比较草稿（`'draft'`）或两个已发布版本。 */
    'agent.diff': {
      params: z.object({ agentId: Id, from: AgentDiffEndpoint, to: AgentDiffEndpoint }),
      result: AgentDiff,
    },
    /** 导出 Markdown（YAML 头部 + 指令正文）。 */
    'agent.export': {
      params: z.object({
        agentId: Id,
        version: z.number().int().positive().optional(),
      }),
      result: z.object({ markdown: z.string() }),
    },
    /** 导入 Markdown 为草稿（`source: 'imported'`）；格式错误时报 `agent.invalid`。 */
    'agent.import': {
      params: z.object({ markdown: z.string().min(1).max(200_000) }),
      result: AgentDetail,
    },
    /** 生效配置预览：合并后的系统提示词、最终工具 / Skills、权限规则与上下文预算。 */
    'agent.effectiveConfig': {
      params: z.object({ agentId: Id, sessionId: Id.optional() }),
      result: AgentEffectiveConfig,
    },
    /** 诊断包导出前的清单（M3-13）：只含计数与版本，不含任何凭据或路径。 */
    'diagnostics.summary': {
      params: DiagnosticsExportInput,
      result: DiagnosticsSummary,
    },
    /** 生成脱敏诊断包 zip；`cancelled` 表示用户在保存对话框中取消（M3-13）。 */
    'diagnostics.export': {
      params: DiagnosticsExportInput,
      result: DiagnosticsExportResult,
    },
    /** 在系统文件管理器中显示诊断包（M3-13）。 */
    'diagnostics.showInFolder': {
      params: z.object({ path: z.string().min(1) }),
      result: z.object({ shown: z.boolean() }),
    },
    'command.list': {
      params: z.object({}),
      result: z.object({ commands: z.array(BackgroundCommand) }),
    },
    'command.output': {
      params: z.object({ commandId: Id }),
      result: BackgroundCommandOutput,
    },
    'command.stop': {
      params: z.object({ commandId: Id }),
      result: BackgroundCommand,
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
    /** MCP 服务的连接状态变化（M3-09）。 */
    'mcp.status': McpStatusEvent,
    /** 自动更新状态变化（M5-06）；界面据此刷新更新设置与提示。 */
    'update.status': UpdateStatus,
    /** 活动中心快照有变化（M4-06）；界面重新读取 `activity.list`。 */
    'activity.changed': z.object({}),
    /** 点击系统通知后打开对应会话（M4-06）；界面负责切到会话页。 */
    'activity.open': z.object({ sessionId: Id }),
    'command.changed': z.object({ commandId: Id }),
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
