/**
 * 界面状态层（M0-15a，架构 §19、§22）：Zustand store 保存会话列表与各会话的事件投影。
 *
 * - **投影**：直接复用 `core` 的 `reduceSession`；持久化事件与实时增量都经它归约，seq 不大于
 *   `lastSeq` 的事件被忽略，因此补发与实时重叠时消息不重复。
 * - **订阅与恢复**：选中会话时 `session.subscribe(afterSeq)`，`afterSeq` 取已有投影的 `lastSeq`
 *   （首次或窗口刷新后为 0，从数据库补发）；订阅响应返回之前到达的实时事件先缓存，补发归约后再
 *   归约，避免补发的事件因 seq 较小被丢弃。同一时间只订阅当前会话，切走时取消订阅；投影保留，
 *   切回时只补发之后的事件。
 * - **动作**：刷新列表、新建会话、重命名与删除（归档，M2-02）、发送输入、停止。失败时把错误码写入 `error`，由界面经 i18n 显示。
 * - **等待开始**：输入已发送、但这一轮还没开始（排队或宿主启动中）时，投影里还没有运行中的轮次；
 *   `awaitingTurn` 记下这段时间，界面与列表把会话当作运行中（可以停止、不能再发送）。收到
 *   `turn.started`（或该轮结束、会话崩溃）、发送失败或停止成功时清除。
 * - **设置**：`loadSettings` 读取、`updateSettings` 保存设置，结果保存在 `settings`；失败时同样写入 `error`。
 *   Key 只能写入（`saveCredential`）与查询是否已保存（`credentialStatus`），没有读出明文的接口。
 * - **项目**（M1-16a）：`refreshProjects` 读取已打开过的项目；`openProject` 用系统对话框选择文件夹。
 * - **撤销**（M1-16b；M2-08 起检查点来自会话投影）：`previewRestore` / `restoreCheckpoint` 预览与恢复。
 * - **文件改动**（M2-07）：订阅时与收到 `file.changed`、`checkpoint.restored` 后重新读取当前会话的改动记录（`changes.list`，只保留
 *   最新一次请求的结果）；`changeContent` 读取一次改动前后的内容，`revertChanges` 整文件撤销、
 *   `revertHunk` 按块撤销后重新读取。
 * - **审批**（M1-11b）：当前会话的未决审批经 `approval.pending` 读取，订阅时与收到 `approval.changed`
 *   通知后重新读取；`resolveApproval` 作出决定（失败时写入 `error`，审批仍保留）。
 *
 * 不依赖 React 与 DOM，便于在 Node 中测试；组件通过 `useStore(store, selector)` 读取。
 */
import { createSessionView, reduceSession, sessionStatus, type SessionView } from '@cairn/core'
import {
  RpcError,
  type AgentDefinitionRef,
  type AgentDetail,
  type AgentDiff,
  type AgentDiffEndpoint,
  type AgentDraftInput,
  type AgentEffectiveConfig,
  type AgentSource,
  type AgentSummary,
  type AgentVersionSummary,
  type ActivityDecision,
  type ActivityListResult,
  type DiagnosticsExportInput,
  type DiagnosticsExportResult,
  type DiagnosticsSummary,
  type ContentPart,
  type ApprovalDecision,
  type MainForRenderer,
  type CheckpointRestorePlan,
  type ChangeSetConflictResolution,
  type ChangeSetInfo,
  type ChangeSetSummary,
  type ErrorInfo,
  type EventEnvelope,
  type FileChangeSummary,
  type FileContent,
  type McpLogEntry,
  type McpServerDetail,
  type McpServerInput,
  type McpServerSummary,
  type McpStatusEvent,
  type McpToolSummary,
  type ModelRef,
  type PermissionEffect,
  type PendingApproval,
  type PermissionRule,
  type PermissionRuleEntry,
  type ProjectSummary,
  type ProviderConfig,
  type RunInspectResult,
  type SessionSummary,
  type Settings,
  type SettingsPatch,
  type ShellPreference,
  type SkillDetail,
  type SkillInstallSource,
  type SkillSource,
  type SkillSummary,
  type ToolCategory,
} from '@cairn/protocol'
import type { z } from 'zod'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { MainApi } from './api.js'

type Requests = (typeof MainForRenderer)['requests']
export type ProviderTestResult = z.output<Requests['provider.test']['result']>
export type ProviderModelsResult = z.output<Requests['provider.models']['result']>

export interface InspectionState {
  readonly loading: boolean
  readonly result: RunInspectResult | undefined
  readonly error: ErrorInfo | undefined
}

export interface SessionState {
  /** 会话列表（按最近更新排序，由主进程决定）。 */
  readonly sessions: readonly SessionSummary[]
  /** 各会话的事件投影。 */
  readonly views: Readonly<Record<string, SessionView>>
  readonly activeSessionId: string | undefined
  /** 已发送输入、等待这一轮开始的会话。 */
  readonly awaitingTurn: Readonly<Record<string, true>>
  /** 各会话的未决审批（按请求顺序）；只读取当前会话的。 */
  readonly approvals: Readonly<Record<string, readonly PendingApproval[]>>
  /** 各会话的文件改动记录（按发生顺序）；只读取当前会话的。 */
  readonly changes: Readonly<Record<string, readonly FileChangeSummary[]>>
  /** 各会话的改动集汇总（按创建顺序）；只读取当前会话的。 */
  readonly changeSets: Readonly<Record<string, readonly ChangeSetSummary[]>>
  /** 改动集汇总正在读取。 */
  readonly changeSetsLoading: Readonly<Record<string, boolean>>
  /** 已读取的改动集详情，键为 changeSetId。 */
  readonly changeSetDetails: Readonly<Record<string, ChangeSetInfo>>
  /** 改动集详情正在读取，键为 changeSetId。 */
  readonly changeSetLoading: Readonly<Record<string, boolean>>
  /** 改动集读取或操作失败，键为 changeSetId。 */
  readonly changeSetErrors: Readonly<Record<string, ErrorInfo>>
  /** 已打开过的项目（按打开时间倒序）。 */
  readonly projects: readonly ProjectSummary[]
  /** 最近读取或保存的设置；读取之前为 undefined。 */
  readonly settings: Settings | undefined
  /** 最近一次失败的错误；界面显示后可以清除。 */
  readonly error: ErrorInfo | undefined
  /** 已保存的 Agent（M3-12）：内置编程助手加上用户与导入的 Agent。 */
  readonly agents: readonly AgentSummary[]
  /** 最近在会话里选用过的 Agent，最近的在前。 */
  readonly recentAgents: readonly string[]
  /** 运行检查器的按需结果，键为 `inspectionKey(sessionId, runId)`。 */
  readonly inspections: Readonly<Record<string, InspectionState>>
  /** 跨会话活动中心快照（M4-07）；读取之前为 undefined。 */
  readonly activity: ActivityListResult | undefined
  /** 活动中心正在读取快照。 */
  readonly activityLoading: boolean
  /** 活动中心最近一次读取失败。 */
  readonly activityError: ErrorInfo | undefined
}

export interface SessionActions {
  refreshSessions(): Promise<void>
  /** 新建会话并选中，返回会话 id；失败时返回 undefined。 */
  createSession(projectPath: string, title?: string): Promise<string | undefined>
  /** 重命名会话（M2-02），成功后刷新列表；返回是否成功。 */
  renameSession(sessionId: string, title: string): Promise<boolean>
  /** 删除（归档）会话（M2-02）：是当前会话时先取消选中；成功后刷新列表。 */
  archiveSession(sessionId: string): Promise<boolean>
  /** 更换会话的模型（M2-04），下一轮生效；返回是否成功。 */
  setSessionModel(sessionId: string, model: ModelRef): Promise<boolean>
  /** 选中会话并订阅其事件；传 undefined 取消选中。 */
  selectSession(sessionId: string | undefined): Promise<void>
  /** 向当前会话发送文本输入；没有发送（空输入、未选中会话或请求失败）时返回 false。 */
  /** `mode` 省略或为 `normal` 时不传给主进程，避免改掉已有调用的请求体。 */
  sendPrompt(text: string, mode?: 'normal' | 'plan'): Promise<boolean>
  /** 批准待审计划。`steps` 是改过的步骤标题；省略表示按原文执行。 */
  approvePlan(planId: string, steps?: readonly { id: string; title: string }[]): Promise<boolean>
  /** 带着说明重新规划。新的一轮仍是计划模式。 */
  replan(planId: string, feedback: string): Promise<boolean>
  /** 放弃待审计划，不开始新的一轮。 */
  abandonPlan(planId: string): Promise<boolean>
  /** 立刻压缩当前会话（M3-03）。失败时返回 false，调用方可以恢复草稿。 */
  compactSession(): Promise<boolean>
  /** 保存用户编辑的会话要点（M3-04）。失败时返回 false。 */
  updateBrief(sessionId: string, content: string): Promise<boolean>
  /** 停止当前会话正在进行的一轮。 */
  abort(): Promise<void>
  /** 决定当前会话的一个审批；成功时返回 true。 */
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ): Promise<boolean>
  refreshProjects(): Promise<void>
  /** 用系统对话框选择文件夹作为项目；取消或失败时返回 undefined。 */
  openProject(): Promise<ProjectSummary | undefined>
  /** 修改项目名称或开关（M3-02）；失败时返回 undefined。 */
  updateProject(
    projectId: string,
    patch: { name?: string; readAgentsMd?: boolean; enableProjectSkills?: boolean },
  ): Promise<ProjectSummary | undefined>
  /** 从列表移除项目（M3-02），不删除目录和会话；成功时返回 true。 */
  removeProject(projectId: string): Promise<boolean>
  /**
   * 已发现的技能（M3-08）。给出 `projectId` 时一并列出该项目开启后的项目内技能；
   * 失败时返回 undefined。
   */
  listSkills(projectId?: string): Promise<SkillSummary[] | undefined>
  /** 一份技能的原文与文件；找不到或失败时返回 undefined。 */
  getSkill(input: {
    name: string
    source: SkillSource
    projectId?: string
  }): Promise<SkillDetail | undefined>
  /** 用系统对话框选择文件夹或 zip；取消或失败时返回 undefined。 */
  pickSkillSource(kind: 'directory' | 'zip'): Promise<SkillInstallSource | undefined>
  /**
   * 预览（`confirm` 省略或为 false）或安装一份技能（M3-08）。
   * 失败时返回 undefined，错误码写入 `error`（例如 `skills.duplicate`）。
   */
  installSkill(
    source: SkillInstallSource,
    confirm?: boolean,
  ): Promise<{ installed: boolean; skill: SkillDetail } | undefined>
  /** 卸载用户安装的技能；成功时返回 true。 */
  uninstallSkill(name: string): Promise<boolean>
  /** 启用、停用或改“始终加载”；返回更新后的摘要。 */
  setSkillEnabled(input: {
    name: string
    source: SkillSource
    projectId?: string
    enabled?: boolean
    pinned?: boolean
  }): Promise<SkillSummary | undefined>
  /** 已配置的 MCP 服务（M3-10）；失败时返回 undefined。 */
  listMcpServers(): Promise<McpServerSummary[] | undefined>
  /** 一份 MCP 配置、凭据状态与当前工具；失败时返回 undefined。 */
  getMcpServer(serverId: string): Promise<McpServerDetail | undefined>
  /** 添加服务并立即连接；失败时返回 undefined（错误写入 `error`）。 */
  addMcpServer(input: McpServerInput): Promise<McpServerDetail | undefined>
  /** 修改服务并重新连接；失败时返回 undefined。 */
  updateMcpServer(serverId: string, server: McpServerInput): Promise<McpServerDetail | undefined>
  /** 删除配置与凭据；成功时返回 true。 */
  removeMcpServer(serverId: string): Promise<boolean>
  /** 重新连接；失败时返回 undefined。 */
  reconnectMcpServer(serverId: string): Promise<McpServerSummary | undefined>
  /** 启用或停用；失败时返回 undefined。 */
  setMcpServerEnabled(serverId: string, enabled: boolean): Promise<McpServerSummary | undefined>
  /** 修改单个工具的类别与默认效果；失败时返回 undefined。 */
  setMcpTool(input: {
    serverId: string
    name: string
    category?: ToolCategory
    effect?: PermissionEffect
  }): Promise<McpToolSummary | undefined>
  /** 最近若干条连接日志；失败时返回 undefined。 */
  mcpLogs(serverId: string): Promise<McpLogEntry[] | undefined>
  /** 订阅 MCP 连接状态；返回取消订阅函数。 */
  onMcpStatus(listener: (event: McpStatusEvent) => void): () => void
  /** 重新读取 Agent 列表（M3-12）。 */
  refreshAgents(input?: {
    includeArchived?: boolean
    source?: AgentSource
    status?: 'draft' | 'published'
    query?: string
  }): Promise<AgentSummary[] | undefined>
  /** 一份 Agent 的当前状态（草稿优先）；失败时返回 undefined。 */
  getAgent(agentId: string, version?: number): Promise<AgentDetail | undefined>
  /** 保存草稿；校验错误由主进程返回在 detail.validation 中。 */
  saveAgentDraft(definition: AgentDraftInput): Promise<AgentDetail | undefined>
  publishAgent(agentId: string): Promise<AgentDetail | undefined>
  duplicateAgent(agentId: string): Promise<AgentDetail | undefined>
  archiveAgent(agentId: string): Promise<AgentDetail | undefined>
  unarchiveAgent(agentId: string): Promise<AgentDetail | undefined>
  deleteAgent(agentId: string): Promise<boolean>
  agentVersions(agentId: string): Promise<AgentVersionSummary[] | undefined>
  agentDiff(
    agentId: string,
    from: AgentDiffEndpoint,
    to: AgentDiffEndpoint,
  ): Promise<AgentDiff | undefined>
  /** 导出 Markdown（YAML 头部 + 指令正文）；失败时返回 undefined。 */
  exportAgent(agentId: string, version?: number): Promise<string | undefined>
  /** 导入 Markdown 为草稿；失败时返回 undefined。 */
  importAgent(markdown: string): Promise<AgentDetail | undefined>
  agentEffectiveConfig(
    agentId: string,
    sessionId?: string,
  ): Promise<AgentEffectiveConfig | undefined>
  /** 获取诊断包导出前清单（M3-13）。 */
  diagnosticsSummary(input?: DiagnosticsExportInput): Promise<DiagnosticsSummary | undefined>
  /** 导出脱敏诊断包 zip（M3-13）。 */
  exportDiagnostics(input?: DiagnosticsExportInput): Promise<DiagnosticsExportResult | undefined>
  /** 在文件夹中显示诊断包文件（M3-13）。 */
  showDiagnosticsInFolder(path: string): Promise<boolean>
  /** 在会话中切换 Agent（新建一个运行）；运行中会失败。 */
  setSessionAgent(sessionId: string, agent: AgentDefinitionRef): Promise<boolean>
  /** 按需读取运行检查器；`runId` 省略时读取会话当前根运行。 */
  inspectRun(sessionId: string, runId?: string): Promise<RunInspectResult | undefined>
  /** 重新读取活动中心快照（M4-07）。 */
  refreshActivity(): Promise<void>
  /** 在活动中心就地决定一个审批；成功后刷新快照。 */
  resolveActivity(
    approvalId: string,
    decision: ActivityDecision,
    feedback?: string,
  ): Promise<boolean>
  /** 订阅“打开活动对应会话”的请求（通知点击或活动页跳转）。 */
  onActivityOpen(listener: (input: { sessionId: string }) => void): () => void
  loadSettings(): Promise<Settings | undefined>
  /** 保存设置，返回保存后的全部设置；失败时返回 undefined。 */
  updateSettings(patch: SettingsPatch): Promise<Settings | undefined>
  /** 保存 Key；成功时返回 true。 */
  saveCredential(ref: string, secret: string): Promise<boolean>
  /** Key 是否已保存、系统加密是否可用；失败时返回 undefined。 */
  credentialStatus(ref: string): Promise<{ configured: boolean; available: boolean } | undefined>
  /** 测试供应商的连接（M2-10）；请求本身失败时返回 undefined（错误写入 `error`）。 */
  testProvider(
    provider: ProviderConfig,
    modelId: string,
    secret?: string,
  ): Promise<ProviderTestResult | undefined>
  /** 拉取供应商的模型列表（M2-10）；请求本身失败时返回 undefined。 */
  fetchModels(provider: ProviderConfig, secret?: string): Promise<ProviderModelsResult | undefined>
  /** 保存的全局与项目权限规则（M2-11）；失败时返回 undefined。 */
  permissionRules(): Promise<PermissionRuleEntry[] | undefined>
  /** 手动添加一条权限规则（M2-11）；失败时返回 undefined。 */
  addPermissionRule(
    rule: PermissionRule,
    projectId?: string,
  ): Promise<PermissionRuleEntry | undefined>
  /** 删除一条保存的权限规则（M2-11）；成功时返回 true。 */
  deletePermissionRule(ruleId: string): Promise<boolean>
  /** 可选的 shell 与自动选择的结果（M2-09）；失败时返回 undefined。 */
  shellOptions(): Promise<{ detected: string; options: ShellPreference[] } | undefined>
  /** 预览恢复到检查点将改动的文件；失败时返回 undefined。 */
  previewRestore(
    sessionId: string,
    checkpointId: string,
  ): Promise<CheckpointRestorePlan | undefined>
  /** 把工作区恢复到检查点；失败时返回 undefined。 */
  restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Promise<CheckpointRestorePlan | undefined>
  /** 重新读取会话的改动记录；失败时保留之前的结果。 */
  loadChanges(sessionId: string): Promise<void>
  /** 一次改动前后的内容；失败时返回 undefined。 */
  changeContent(
    sessionId: string,
    changeId: string,
  ): Promise<{ before?: FileContent | undefined; after?: FileContent | undefined } | undefined>
  /** 整文件撤销这些改动，成功后重新读取改动记录；返回是否成功。 */
  revertChanges(sessionId: string, changeIds: readonly string[]): Promise<boolean>
  /** 撤销一条改动中的一块，成功后重新读取改动记录；返回是否成功。 */
  revertHunk(sessionId: string, changeId: string, hunkIndex: number): Promise<boolean>
  /** 重新读取会话的改动集汇总；失败时保留之前的结果。 */
  loadChangeSets(sessionId: string): Promise<void>
  /** 读取一个改动集的详情（含文件 diff）。 */
  loadChangeSet(sessionId: string, changeSetId: string): Promise<ChangeSetInfo | undefined>
  /** 接受全部或部分待处理文件；成功时更新详情并重新读取汇总。 */
  applyChangeSet(
    sessionId: string,
    changeSetId: string,
    paths?: readonly string[],
  ): Promise<ChangeSetInfo | undefined>
  /** 拒绝全部或部分文件；成功时更新详情并重新读取汇总。 */
  rejectChangeSet(
    sessionId: string,
    changeSetId: string,
    paths?: readonly string[],
  ): Promise<ChangeSetInfo | undefined>
  /** 处理一个冲突文件：保留主工作区、采用子运行或手动处理。 */
  resolveChangeSetConflict(
    sessionId: string,
    changeSetId: string,
    path: string,
    resolution: ChangeSetConflictResolution,
  ): Promise<ChangeSetInfo | undefined>
  clearError(): void
  /** 取消订阅并停止接收事件。 */
  dispose(): void
}

export type SessionStore = StoreApi<SessionState & SessionActions>

const toError = (error: unknown): ErrorInfo =>
  error instanceof RpcError ? error.toInfo() : { code: 'unknown' }

/** 最近使用的 Agent（M3-12）：只存 id，界面按列表过滤；本地存储不可用时只在本次会话里保留。 */
const RECENT_AGENTS_KEY = 'cairn.recentAgents'
const RECENT_AGENTS_MAX = 8

export const inspectionKey = (sessionId: string, runId?: string) =>
  `${sessionId}:${runId ?? 'root'}`

export function readRecentAgents(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): string[] {
  try {
    const raw = storage?.getItem(RECENT_AGENTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string').slice(0, RECENT_AGENTS_MAX)
      : []
  } catch {
    return []
  }
}

function writeRecentAgents(ids: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(RECENT_AGENTS_KEY, JSON.stringify(ids))
  } catch {
    // 隐私模式或测试环境里 localStorage 不可用
  }
}

/** 这些事件说明等待的那一轮已经开始或不会再开始。 */
const TURN_SETTLED = new Set(['turn.started', 'turn.failed', 'turn.aborted', 'session.crashed'])

/** 这些事件之后重新读取未决审批。 */

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string) => {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

/** 界面显示的会话状态：等待开始时视为运行中。 */
const displayStatus = (state: Pick<SessionState, 'awaitingTurn'>, view: SessionView) =>
  state.awaitingTurn[view.sessionId] ? 'running' : sessionStatus(view)

/** 只更新列表中一个会话的状态。 */
const withStatus = (
  sessions: readonly SessionSummary[],
  sessionId: string,
  status: SessionSummary['status'],
) => sessions.map((s) => (s.sessionId === sessionId && s.status !== status ? { ...s, status } : s))

/** 把事件归约进会话投影，并同步等待标记与列表中的状态。 */
function reduceInto(
  state: SessionState,
  sessionId: string,
  events: readonly EventEnvelope[],
): Pick<SessionState, 'views' | 'sessions' | 'awaitingTurn'> {
  let view = state.views[sessionId] ?? createSessionView(sessionId)
  for (const event of events) view = reduceSession(view, event)
  const awaitingTurn = events.some((e) => TURN_SETTLED.has(e.type))
    ? withoutKey(state.awaitingTurn, sessionId)
    : state.awaitingTurn
  return {
    views: { ...state.views, [sessionId]: view },
    awaitingTurn,
    sessions: state.sessions.map((session) => {
      if (session.sessionId !== sessionId) return session
      const status = displayStatus({ awaitingTurn }, view)
      const title = view.info ? view.info.title : session.title
      return session.status === status && session.title === title
        ? session
        : { ...session, status, title }
    }),
  }
}

export function createSessionStore(api: MainApi): SessionStore {
  const receive = (state: SessionState, sessionId: string, events: readonly EventEnvelope[]) =>
    reduceInto(state, sessionId, events)
  /** 正在等待订阅响应的会话 → 期间到达的实时事件。 */
  const pending = new Map<string, EventEnvelope[]>()
  /** 当前已订阅的会话（订阅响应已返回）。 */
  let subscribed: string | undefined

  let loadApprovalsFor: (sessionId: string) => Promise<void> = () => Promise.resolve()
  let loadChangesFor: (sessionId: string) => Promise<void> = () => Promise.resolve()
  let loadChangeSetsFor: (sessionId: string) => Promise<void> = () => Promise.resolve()
  let loadChangeSetFor: (
    sessionId: string,
    changeSetId: string,
  ) => Promise<ChangeSetInfo | undefined> = () => Promise.resolve(undefined)
  /** 各会话最近一次读取改动记录的序号：较早的请求晚返回时丢弃。 */
  const changeRequests = new Map<string, number>()
  /** 各会话最近一次读取改动集汇总的序号。 */
  const changeSetListRequests = new Map<string, number>()
  /** 各改动集最近一次读取详情的序号。 */
  const changeSetRequests = new Map<string, number>()
  /** 检查器请求序号：切换标签后较早的响应不应覆盖新结果。 */
  const inspectionRequests = new Map<string, number>()
  const store = createStore<SessionState & SessionActions>()((set, get) => {
    const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action()
      } catch (error) {
        set({ error: toError(error) })
        return undefined
      }
    }

    const setAwaiting = (sessionId: string, awaiting: boolean) =>
      set((state) => {
        const awaitingTurn = awaiting
          ? { ...state.awaitingTurn, [sessionId]: true as const }
          : withoutKey(state.awaitingTurn, sessionId)
        if (awaitingTurn === state.awaitingTurn) return {}
        const view = state.views[sessionId]
        return {
          awaitingTurn,
          sessions: view
            ? withStatus(state.sessions, sessionId, displayStatus({ awaitingTurn }, view))
            : state.sessions,
        }
      })

    /** 重新读取会话的未决审批；失败时保留之前的结果。 */
    const loadApprovals = async (sessionId: string) => {
      const result = await run(() => api.request('approval.pending', { sessionId }))
      if (result)
        set((state) => ({ approvals: { ...state.approvals, [sessionId]: result.approvals } }))
    }

    loadApprovalsFor = loadApprovals

    const loadChanges = async (sessionId: string) => {
      const request = (changeRequests.get(sessionId) ?? 0) + 1
      changeRequests.set(sessionId, request)
      const result = await run(() => api.request('changes.list', { sessionId }))
      if (result && changeRequests.get(sessionId) === request) {
        // 测试替身可能不返回列表
        set((state) => ({ changes: { ...state.changes, [sessionId]: result.changes ?? [] } }))
      }
    }
    loadChangesFor = loadChanges

    const loadChangeSets = async (sessionId: string) => {
      const request = (changeSetListRequests.get(sessionId) ?? 0) + 1
      changeSetListRequests.set(sessionId, request)
      set((state) => ({
        changeSetsLoading: { ...state.changeSetsLoading, [sessionId]: true },
      }))
      try {
        const result = await api.request('changeset.list', { sessionId })
        if (changeSetListRequests.get(sessionId) !== request) return
        set((state) => ({
          changeSets: { ...state.changeSets, [sessionId]: result.changeSets ?? [] },
          changeSetsLoading: { ...state.changeSetsLoading, [sessionId]: false },
        }))
      } catch (error) {
        if (changeSetListRequests.get(sessionId) !== request) return
        set((state) => ({
          changeSetsLoading: { ...state.changeSetsLoading, [sessionId]: false },
          error: toError(error),
        }))
      }
    }
    loadChangeSetsFor = loadChangeSets

    const loadChangeSet = async (sessionId: string, changeSetId: string) => {
      const request = (changeSetRequests.get(changeSetId) ?? 0) + 1
      changeSetRequests.set(changeSetId, request)
      set((state) => ({
        changeSetLoading: { ...state.changeSetLoading, [changeSetId]: true },
        changeSetErrors: withoutKey(state.changeSetErrors, changeSetId),
      }))
      try {
        const result = await api.request('changeset.get', { sessionId, changeSetId })
        if (changeSetRequests.get(changeSetId) !== request) return undefined
        set((state) => ({
          changeSetDetails: { ...state.changeSetDetails, [changeSetId]: result.changeSet },
          changeSetLoading: { ...state.changeSetLoading, [changeSetId]: false },
        }))
        return result.changeSet
      } catch (error) {
        if (changeSetRequests.get(changeSetId) !== request) return undefined
        set((state) => ({
          changeSetLoading: { ...state.changeSetLoading, [changeSetId]: false },
          changeSetErrors: { ...state.changeSetErrors, [changeSetId]: toError(error) },
        }))
        return undefined
      }
    }
    loadChangeSetFor = loadChangeSet

    const mutateChangeSet = async (
      sessionId: string,
      changeSetId: string,
      action: () => Promise<{ changeSet: ChangeSetInfo }>,
    ) => {
      set((state) => ({
        changeSetLoading: { ...state.changeSetLoading, [changeSetId]: true },
        changeSetErrors: withoutKey(state.changeSetErrors, changeSetId),
      }))
      try {
        const result = await action()
        set((state) => ({
          changeSetDetails: { ...state.changeSetDetails, [changeSetId]: result.changeSet },
          changeSetLoading: { ...state.changeSetLoading, [changeSetId]: false },
        }))
        await Promise.all([loadChangeSets(sessionId), loadChanges(sessionId)])
        return result.changeSet
      } catch (error) {
        set((state) => ({
          changeSetLoading: { ...state.changeSetLoading, [changeSetId]: false },
          changeSetErrors: { ...state.changeSetErrors, [changeSetId]: toError(error) },
        }))
        return undefined
      }
    }

    const unsubscribe = async (sessionId: string) => {
      pending.delete(sessionId)
      if (subscribed === sessionId) subscribed = undefined
      await run(() => api.request('session.unsubscribe', { sessionId }))
    }

    return {
      sessions: [],
      views: {},
      activeSessionId: undefined,
      awaitingTurn: {},
      approvals: {},
      changes: {},
      changeSets: {},
      changeSetsLoading: {},
      changeSetDetails: {},
      changeSetLoading: {},
      changeSetErrors: {},
      projects: [],
      settings: undefined,
      error: undefined,
      agents: [],
      recentAgents: readRecentAgents(),
      inspections: {},
      activity: undefined,
      activityLoading: false,
      activityError: undefined,

      async refreshSessions() {
        const result = await run(() => api.request('session.list', {}))
        if (!result) return
        // 已订阅的会话以本地投影的状态为准（比列表请求更新）
        const state = get()
        set({
          sessions: result.sessions.map((s) => {
            const view = state.views[s.sessionId]
            return view && s.sessionId === subscribed
              ? { ...s, status: displayStatus(state, view) }
              : s
          }),
        })
      },

      async createSession(projectPath, title) {
        const created = await run(() =>
          api.request(
            'session.create',
            title === undefined ? { projectPath } : { projectPath, title },
          ),
        )
        if (!created) return undefined
        await get().refreshSessions()
        await get().selectSession(created.sessionId)
        return created.sessionId
      },

      async renameSession(sessionId, title) {
        const done = await run(() => api.request('session.rename', { sessionId, title }))
        if (done === undefined) return false
        await get().refreshSessions()
        return true
      },

      async archiveSession(sessionId) {
        const done = await run(() => api.request('session.archive', { sessionId }))
        if (done === undefined) return false
        if (get().activeSessionId === sessionId) await get().selectSession(undefined)
        await get().refreshSessions()
        return true
      },

      async setSessionModel(sessionId, model) {
        const done = await run(() => api.request('session.setModel', { sessionId, model }))
        return done !== undefined
      },

      async selectSession(sessionId) {
        const previous = get().activeSessionId
        if (previous === sessionId) return
        set({ activeSessionId: sessionId })
        if (previous !== undefined) await unsubscribe(previous)
        if (sessionId === undefined) return
        pending.set(sessionId, [])
        const afterSeq = get().views[sessionId]?.lastSeq ?? 0
        const result = await run(() => api.request('session.subscribe', { sessionId, afterSeq }))
        const buffered = pending.get(sessionId)
        pending.delete(sessionId)
        // 等待期间已切到其他会话，或订阅失败
        if (!result || get().activeSessionId !== sessionId) {
          if (result) await unsubscribe(sessionId)
          return
        }
        subscribed = sessionId
        set((state) => receive(state, sessionId, [...result.events, ...(buffered ?? [])]))
        await Promise.all([
          loadApprovals(sessionId),
          loadChanges(sessionId),
          loadChangeSets(sessionId),
        ])
      },

      async compactSession() {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return false
        const result = await run(() => api.request('session.compact', { sessionId }))
        return result !== undefined
      },

      async updateBrief(sessionId, content) {
        const result = await run(() => api.request('session.brief.update', { sessionId, content }))
        return result !== undefined
      },

      async sendPrompt(text, mode = 'normal') {
        const sessionId = get().activeSessionId
        const trimmed = text.trim()
        if (sessionId === undefined || trimmed === '') return false
        const content: ContentPart[] = [{ type: 'text', text: trimmed }]
        // 先标记再请求：turn.started 可能早于请求响应到达
        setAwaiting(sessionId, true)
        const sent = await run(() =>
          api.request('session.prompt', {
            sessionId,
            content,
            ...(mode === 'plan' ? { mode: 'plan' as const } : {}),
          }),
        )
        if (sent === undefined) setAwaiting(sessionId, false)
        return sent !== undefined
      },

      async approvePlan(planId, steps) {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return false
        setAwaiting(sessionId, true)
        const sent = await run(() =>
          api.request('plan.approve', {
            sessionId,
            planId,
            ...(steps && steps.length > 0 ? { steps: [...steps] } : {}),
          }),
        )
        if (sent === undefined) setAwaiting(sessionId, false)
        return sent !== undefined
      },

      async replan(planId, feedback) {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return false
        setAwaiting(sessionId, true)
        const sent = await run(() => api.request('plan.replan', { sessionId, planId, feedback }))
        if (sent === undefined) setAwaiting(sessionId, false)
        return sent !== undefined
      },

      async abandonPlan(planId) {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return false
        const sent = await run(() => api.request('plan.abandon', { sessionId, planId }))
        return sent !== undefined
      },

      async abort() {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return
        const stopped = await run(() => api.request('session.abort', { sessionId }))
        // 排队中的输入被取消时不会产生事件
        if (stopped !== undefined) setAwaiting(sessionId, false)
      },

      async resolveApproval(approvalId, decision, feedback) {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return false
        const trimmed = feedback?.trim()
        const resolved = await run(() =>
          api.request('approval.resolve', {
            sessionId,
            approvalId,
            decision,
            ...(decision === 'deny' && trimmed ? { feedback: trimmed } : {}),
          }),
        )
        await loadApprovals(sessionId)
        return resolved !== undefined
      },

      async refreshProjects() {
        const result = await run(() => api.request('project.list', {}))
        // 旧版主进程或测试替身可能不返回列表
        if (result) set({ projects: result.projects ?? [] })
      },

      async openProject() {
        const result = await run(() => api.request('project.open', {}))
        const project = result?.project
        if (!project) return undefined
        set((state) => ({
          projects: [project, ...state.projects.filter((p) => p.projectId !== project.projectId)],
        }))
        return project
      },

      async updateProject(projectId, patch) {
        const project = await run(() => api.request('project.update', { projectId, ...patch }))
        if (!project) return undefined
        set((state) => ({
          projects: state.projects.map((item) => (item.projectId === projectId ? project : item)),
        }))
        return project
      },

      async removeProject(projectId) {
        const removed = await run(() => api.request('project.remove', { projectId }))
        if (removed === undefined) return false
        set((state) => ({
          projects: state.projects.filter((item) => item.projectId !== projectId),
        }))
        return true
      },

      listSkills: async (projectId) =>
        (await run(() => api.request('skill.list', projectId === undefined ? {} : { projectId })))
          ?.skills,

      getSkill: (input) => run(() => api.request('skill.get', input)),

      pickSkillSource: async (kind) =>
        (await run(() => api.request('skill.pickSource', { kind })))?.source,

      installSkill: (source, confirm) =>
        run(() =>
          api.request('skill.install', confirm === undefined ? { source } : { source, confirm }),
        ),

      uninstallSkill: async (name) =>
        (await run(() => api.request('skill.uninstall', { name }))) !== undefined,

      setSkillEnabled: (input) => run(() => api.request('skill.setEnabled', input)),

      listMcpServers: async () => (await run(() => api.request('mcp.list', {})))?.servers,

      getMcpServer: (serverId) => run(() => api.request('mcp.get', { serverId })),

      addMcpServer: (input) => run(() => api.request('mcp.add', input)),

      updateMcpServer: (serverId, server) =>
        run(() => api.request('mcp.update', { serverId, server })),

      removeMcpServer: async (serverId) =>
        (await run(() => api.request('mcp.remove', { serverId }))) !== undefined,

      reconnectMcpServer: (serverId) => run(() => api.request('mcp.reconnect', { serverId })),

      setMcpServerEnabled: (serverId, enabled) =>
        run(() => api.request('mcp.setEnabled', { serverId, enabled })),

      setMcpTool: (input) => run(() => api.request('mcp.setTool', input)),

      mcpLogs: async (serverId) => (await run(() => api.request('mcp.logs', { serverId })))?.logs,

      onMcpStatus: (listener) => api.on('mcp.status', listener),

      async refreshAgents(input) {
        const result = await run(() => api.request('agent.list', input ?? {}))
        if (!result) return undefined
        set({ agents: result.agents })
        return result.agents
      },

      getAgent: (agentId, version) =>
        run(() =>
          api.request('agent.get', version === undefined ? { agentId } : { agentId, version }),
        ),

      saveAgentDraft: (definition) => run(() => api.request('agent.saveDraft', { definition })),

      publishAgent: (agentId) => run(() => api.request('agent.publish', { agentId })),

      duplicateAgent: (agentId) => run(() => api.request('agent.duplicate', { agentId })),

      archiveAgent: (agentId) => run(() => api.request('agent.archive', { agentId })),

      unarchiveAgent: (agentId) => run(() => api.request('agent.unarchive', { agentId })),

      deleteAgent: async (agentId) =>
        (await run(() => api.request('agent.delete', { agentId }))) !== undefined,

      agentVersions: async (agentId) =>
        (await run(() => api.request('agent.versions', { agentId })))?.versions,

      agentDiff: (agentId, from, to) => run(() => api.request('agent.diff', { agentId, from, to })),

      exportAgent: async (agentId, version) =>
        (
          await run(() =>
            api.request('agent.export', version === undefined ? { agentId } : { agentId, version }),
          )
        )?.markdown,

      importAgent: (markdown) => run(() => api.request('agent.import', { markdown })),

      agentEffectiveConfig: (agentId, sessionId) =>
        run(() =>
          api.request(
            'agent.effectiveConfig',
            sessionId === undefined ? { agentId } : { agentId, sessionId },
          ),
        ),

      diagnosticsSummary: (input) => run(() => api.request('diagnostics.summary', input ?? {})),

      exportDiagnostics: (input) => run(() => api.request('diagnostics.export', input ?? {})),

      showDiagnosticsInFolder: async (filePath) =>
        (await run(() => api.request('diagnostics.showInFolder', { path: filePath }))) !==
        undefined,

      async setSessionAgent(sessionId, agent) {
        const done = await run(() => api.request('session.setAgent', { sessionId, agent }))
        if (done === undefined) return false
        set((state) => ({
          recentAgents: [agent.id, ...state.recentAgents.filter((id) => id !== agent.id)].slice(
            0,
            RECENT_AGENTS_MAX,
          ),
        }))
        writeRecentAgents(get().recentAgents)
        return true
      },

      async inspectRun(sessionId, runId) {
        const key = inspectionKey(sessionId, runId)
        const request = (inspectionRequests.get(key) ?? 0) + 1
        inspectionRequests.set(key, request)
        set((state) => ({
          inspections: {
            ...state.inspections,
            [key]: { loading: true, result: state.inspections[key]?.result, error: undefined },
          },
        }))
        try {
          const result = await api.request(
            'run.inspect',
            runId === undefined ? { sessionId } : { sessionId, runId },
          )
          if (inspectionRequests.get(key) === request) {
            set((state) => ({
              inspections: {
                ...state.inspections,
                [key]: { loading: false, result, error: undefined },
              },
            }))
          }
          return result
        } catch (error) {
          if (inspectionRequests.get(key) === request) {
            set((state) => ({
              inspections: {
                ...state.inspections,
                [key]: {
                  loading: false,
                  result: state.inspections[key]?.result,
                  error: toError(error),
                },
              },
            }))
          }
          return undefined
        }
      },

      async refreshActivity() {
        set({ activityLoading: true, activityError: undefined })
        try {
          const result = await api.request('activity.list', {})
          set({ activity: result, activityLoading: false })
        } catch (error) {
          set({ activityLoading: false, activityError: toError(error) })
        }
      },

      async resolveActivity(approvalId, decision, feedback) {
        const done = await run(() =>
          api.request(
            'activity.resolve',
            feedback === undefined || feedback.trim() === ''
              ? { approvalId, decision }
              : { approvalId, decision, feedback: feedback.trim() },
          ),
        )
        if (done === undefined) return false
        await get().refreshActivity()
        return true
      },

      onActivityOpen: (listener) => api.on('activity.open', listener),

      async loadSettings() {
        const result = await run(() => api.request('settings.get', {}))
        if (result) set({ settings: result })
        return result
      },

      async updateSettings(patch) {
        const result = await run(() => api.request('settings.update', patch))
        if (result) set({ settings: result })
        return result
      },

      async saveCredential(ref, secret) {
        return (await run(() => api.request('credentials.set', { ref, secret }))) !== undefined
      },

      credentialStatus: (ref) => run(() => api.request('credentials.status', { ref })),

      shellOptions: () => run(() => api.request('settings.shell', {})),

      permissionRules: async () => (await run(() => api.request('permissions.list', {})))?.rules,

      addPermissionRule: (rule, projectId) =>
        run(() =>
          api.request('permissions.add', {
            rule,
            ...(projectId !== undefined ? { projectId } : {}),
          }),
        ),

      deletePermissionRule: async (ruleId) =>
        (await run(() => api.request('permissions.delete', { ruleId }))) !== undefined,

      testProvider: (provider, modelId, secret) =>
        run(() =>
          api.request('provider.test', { provider, modelId, ...(secret ? { secret } : {}) }),
        ),

      fetchModels: (provider, secret) =>
        run(() => api.request('provider.models', { provider, ...(secret ? { secret } : {}) })),

      previewRestore: (sessionId, checkpointId) =>
        run(() => api.request('checkpoint.preview', { sessionId, checkpointId })),

      restoreCheckpoint: (sessionId, checkpointId) =>
        run(() => api.request('checkpoint.restore', { sessionId, checkpointId })),

      loadChanges,

      loadChangeSets,

      loadChangeSet,

      applyChangeSet: (sessionId, changeSetId, paths) =>
        mutateChangeSet(sessionId, changeSetId, () =>
          api.request(
            'changeset.apply',
            paths === undefined
              ? { sessionId, changeSetId }
              : { sessionId, changeSetId, paths: [...paths] },
          ),
        ),

      rejectChangeSet: (sessionId, changeSetId, paths) =>
        mutateChangeSet(sessionId, changeSetId, () =>
          api.request(
            'changeset.reject',
            paths === undefined
              ? { sessionId, changeSetId }
              : { sessionId, changeSetId, paths: [...paths] },
          ),
        ),

      resolveChangeSetConflict: (sessionId, changeSetId, path, resolution) =>
        mutateChangeSet(sessionId, changeSetId, () =>
          api.request('changeset.resolveConflict', {
            sessionId,
            changeSetId,
            path,
            resolution,
          }),
        ),

      changeContent: (sessionId, changeId) =>
        run(() => api.request('changes.content', { sessionId, changeId })),

      async revertChanges(sessionId, changeIds) {
        const done = await run(() =>
          api.request('changes.revert', { sessionId, changeIds: [...changeIds] }),
        )
        await loadChanges(sessionId)
        return done !== undefined
      },

      async revertHunk(sessionId, changeId, hunkIndex) {
        const done = await run(() =>
          api.request('changes.revertHunk', { sessionId, changeId, hunkIndex }),
        )
        await loadChanges(sessionId)
        return done !== undefined
      },

      clearError: () => set({ error: undefined }),

      dispose() {
        offEvents()
        offApprovals()
        offActivity()
        pending.clear()
        inspectionRequests.clear()
        changeSetListRequests.clear()
        changeSetRequests.clear()
        subscribed = undefined
      },
    }
  })

  const offEvents = api.on('session.events', ({ sessionId, events }) => {
    const buffer = pending.get(sessionId)
    if (buffer) {
      buffer.push(...events)
      return
    }
    if (sessionId !== subscribed) return
    store.setState((state) => receive(state, sessionId, events))
    // 恢复检查点会把之后的改动标记为已撤销（M2-07），同样要重新读取
    if (events.some((e) => e.type === 'file.changed' || e.type === 'checkpoint.restored'))
      void loadChangesFor(sessionId)
    const changeSetEvents = events.filter((event) => event.type.startsWith('changeset.'))
    if (changeSetEvents.length > 0) {
      void loadChangeSetsFor(sessionId)
      const ids = new Set<string>()
      for (const event of changeSetEvents) {
        if ('changeSetId' in event.payload && typeof event.payload.changeSetId === 'string') {
          ids.add(event.payload.changeSetId)
        }
      }
      for (const changeSetId of ids) {
        if (store.getState().changeSetDetails[changeSetId] !== undefined) {
          void loadChangeSetFor(sessionId, changeSetId)
        }
      }
    }
  })
  const offApprovals = api.on('approval.changed', ({ sessionId }) => {
    if (sessionId === subscribed) void loadApprovalsFor(sessionId)
  })
  const offActivity = api.on('activity.changed', () => {
    void store.getState().refreshActivity()
  })

  return store
}
