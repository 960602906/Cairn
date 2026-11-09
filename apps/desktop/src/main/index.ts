/**
 * 主进程入口（ADR-0002、ADR-0003，架构 §4、§17）。只做启动引导：确定数据目录、应用安全基线、
 * 组装主进程服务（存储、设置、宿主管理、IPC 网关）、创建窗口。服务本身不依赖 Electron，见 `services/`。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGitRunner, isolatedGitEnv, openShadowRepo } from '@cairn/checkpoint'
import { BUILTIN_CODER_ID, redact } from '@cairn/core'
import type { McpStatusEvent } from '@cairn/protocol'
import { bundledRipgrepPath } from '@cairn/tools'
import { openSqliteStorage } from '@cairn/storage'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron'
import { requiredDirectories, resolveAppPaths } from './app-paths.js'
import { titleBarOverlay, usesTitleBarOverlay, windowChromeOptions } from './window-chrome.js'
import {
  hardenWebContents,
  restrictPermissions,
  secureWebPreferences,
  type NavigationPolicy,
  type WebContentsLike,
} from './security.js'
import { createBlobStore } from './services/blob-store.js'
import { createActivityNotifier } from './services/activity-notifier.js'
import { createActivityService } from './services/activity-service.js'
import { createChangeService } from './services/change-service.js'
import { createChangeSetService } from './services/change-set-service.js'
import { createCommandService } from './services/command-service.js'
import { createCheckpointService } from './services/checkpoint-service.js'
import { checkpointLocation } from './services/checkpoint-location.js'
import { createCredentialCommands, createLocalKeyStore } from './services/credential-store.js'
import { createSessionEventService } from './services/event-service.js'
import { createInspectService } from './services/inspect-service.js'
import { createUtilityHostSpawner } from './services/host-process.js'
import { createHostSupervisor } from './services/host-supervisor.js'
import { loadProjectAgentsMd } from './services/agents-md.js'
import { createSkillService } from './services/skill-service.js'
import { createMcpService } from './services/mcp-service.js'
import { createAgentService } from './services/agent-service.js'
import { DiagnosticsService } from './services/diagnostics-service.js'
import { createProjectService } from './services/project-service.js'
import { createRendererGateway } from './services/renderer-gateway.js'
import { createRendererChannel } from './services/renderer-transport.js'
import { createApprovalService } from './services/approval-service.js'
import { createPermissionService } from './services/permission-service.js'
import { createSessionManager, type RunDefaults } from './services/session-manager.js'
import { createTrialService } from './services/trial-service.js'
import { createWorkspaceService } from './services/workspace-service.js'
import { latestBrief } from './services/brief.js'
import { createBriefService } from './services/brief-service.js'
import { createCompactService } from './services/compact-service.js'
import { createTitleService } from './services/title-service.js'
import { createSafeStorageCipher } from './services/safe-storage-cipher.js'
import { createSettingsService } from './services/settings-service.js'
import { createShellInfo } from './services/shell-info.js'
import { createProviderService } from './services/provider-service.js'
import { hostEnvironment } from '../shared/host-trace.js'
import { checkBundledSearch } from './smoke-search.js'
import {
  isSmokeRun,
  RENDERER_PROBE_SCRIPT,
  runSmokeChecks,
  type CredentialCheck,
  type RendererProbe,
} from './smoke.js'

const paths = resolveAppPaths({
  appData: app.getPath('appData'),
  dev: !app.isPackaged,
  env: process.env,
})
app.setPath('userData', paths.root)
app.setPath('sessionData', paths.session)
for (const dir of requiredDirectories(paths)) mkdirSync(dir, { recursive: true })

const rendererFile = join(import.meta.dirname, '../renderer/index.html')
/** 随应用打包的 ripgrep：构建时复制到 `out/bin/`（electron.vite.config.ts）。 */
const ripgrepPath = bundledRipgrepPath(join(import.meta.dirname, '../bin'))
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
const navigationPolicy: NavigationPolicy = {
  rendererUrl: pathToFileURL(rendererFile).href,
  devServerUrl,
}

/** M0 使用 FakeRuntime；模型与 Agent 配置在 M1 接入设置。 */
const RUN_DEFAULTS: RunDefaults = {
  agent: { id: BUILTIN_CODER_ID, version: 1 },
  model: { providerId: 'fake', modelId: 'fake' },
  mode: 'interactive',
  // 默认不限步数、时长与工具失败次数，长任务可以跑一整晚（2026-11-07）；自定义 Agent 可以自己设限额
  limits: {},
}
/** 退出时等待宿主结束的上限。 */
const SHUTDOWN_TIMEOUT_MS = 5_000

/** 已保存或解析过的 Key（凭据存储创建后接上），错误输出前按原文脱敏。 */
let knownSecrets: () => readonly string[] = () => []
// 日志服务接入前，异常先写到标准错误（经过脱敏）
const reportError = (error: unknown) =>
  console.error('[cairn]', redact(error, { homeDirs: [homedir()], secrets: knownSecrets() }))

/** 读取日志文件末尾的若干行（诊断包用）；不存在或读取失败时返回空串。 */
const DIAGNOSTICS_LOG_TAIL = 500
function readLogFile(file: string): string {
  try {
    if (!existsSync(file)) return ''
    const content = readFileSync(file, 'utf8')
    const lines = content.split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - DIAGNOSTICS_LOG_TAIL)).join('\n')
  } catch (error) {
    reportError(error)
    return ''
  }
}

const storage = openSqliteStorage({ file: paths.database })
/** 凭据（ADR-0010）：界面经 IPC 写入，启动宿主时按提供方配置的凭据引用解析后经 `host.init` 传入。 */
const credentials = createLocalKeyStore({
  file: paths.credentials,
  cipher: createSafeStorageCipher(safeStorage),
  onError: reportError,
})
knownSecrets = () => credentials.knownSecrets()
const settings = createSettingsService({
  file: paths.settings,
  storage,
  systemLocales: () => {
    const preferred = app.getPreferredSystemLanguages()
    return preferred.length > 0 ? preferred : [app.getLocale()]
  },
  onError: reportError,
})
const events = createSessionEventService({ storage, onListenerError: reportError })
const inspect = createInspectService({ storage, events })
const blobs = createBlobStore(paths.blobs)
/** 改动记录（M1-08b）：宿主报告的改动写入 blob 存储与数据库；界面列出与撤销。 */
const changes = createChangeService({
  storage,
  blobs,
  events,
  isBusy: (sessionId) => sessions.isBusy(sessionId) || checkpoints.isRestoring(sessionId),
})
/** 检查点（M1-12c）：列表来自事件，预览与恢复在主进程中打开项目的影子仓库。 */
const checkpoints = createCheckpointService({
  storage,
  events,
  location: (sessionId) => checkpointLocation(paths.checkpoints, storage, sessionId),
  open: openShadowRepo,
  isBusy: (sessionId) => sessions.isBusy(sessionId) || changes.isReverting(sessionId),
})
/** 隔离工作区（M4-08）：写入类子运行的独立副本，启动时清扫上次留下的目录。 */
const workspaces = createWorkspaceService({ root: paths.worktrees, onError: reportError })
void workspaces.sweep().catch(reportError)
/** 改动集（M4-09）：隔离工作区里的改动与主工作区合并，合并前先建检查点。 */
const changeSets = createChangeSetService({
  storage,
  blobs,
  events,
  workspaces,
  checkpoints: { create: (sessionId) => checkpoints.create({ sessionId }) },
  git: createGitRunner({
    env: isolatedGitEnv(process.env, join(paths.worktrees, 'no-global-config')),
  }),
  isBusy: (sessionId) =>
    sessions.isBusy(sessionId) ||
    changes.isReverting(sessionId) ||
    checkpoints.isRestoring(sessionId),
  onError: reportError,
})
/** 后台命令（M4-14）：生命周期跨工具调用，应用退出时结束整个进程树。 */
const commandService = createCommandService({
  storage,
  events,
  shell: () => settings.shell() ?? 'auto',
  isAllowedCwd: async (sessionId, cwd) => {
    const session = storage.sessions.get(sessionId)
    if (!session) return false
    const same = (a: string, b: string) =>
      process.platform === 'win32'
        ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
        : resolve(a) === resolve(b)
    if (same(cwd, session.workspacePath)) return true
    return (await workspaces.list()).some(
      (workspace) => workspace.sessionId === sessionId && same(cwd, workspace.path),
    )
  },
  onError: reportError,
})
/** 权限规则（M1-10c）：权限模式的预设与保存的规则，启动宿主时经 `host.init` 下发。 */
const permissions = createPermissionService({ storage, mode: () => settings.permissionMode() })
/** 审批（M1-11b）：宿主的审批请求等待界面决定；“始终允许”生成的规则通知所有运行中的宿主。 */
const approvals = createApprovalService({
  permissions,
  onRuleAdded: () => sessions.refreshPermissions(),
})
/** 活动中心（M4-06）：跨会话审批、运行与最近完成；只读投影，不保存第二份状态。 */
const activity = createActivityService({
  storage,
  events,
  approvals,
  homeDirs: [homedir()],
  secrets: () => credentials.knownSecrets(),
  onError: reportError,
})
/** 技能（M3-07）：内置示例、用户安装目录，以及项目开关打开后的项目内技能。 */
const skills = createSkillService({
  storage,
  builtinDir: join(import.meta.dirname, '../../resources/skills'),
  userDir: join(paths.root, 'skills'),
  /** 选择安装来源（M3-08）：文件夹或 zip（e2e 中替换 `dialog.showOpenDialog`）。 */
  pickSource: async (kind) => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions =
      kind === 'zip'
        ? { properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] }
        : { properties: ['openDirectory'] }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  },
})
/** MCP 服务（M3-09）：配置、连接与工具调用都在主进程。 */
const mcpStatusListeners = new Set<(event: McpStatusEvent) => void>()
const mcp = createMcpService({
  storage,
  credentials,
  onStatus: (event) => {
    for (const listener of [...mcpStatusListeners]) listener(event)
  },
  onError: reportError,
})
/** Agent 定义（M3-11）：内置编程助手 + 用户/导入的 Agent，草稿与已发布版本分开。 */
const agents = createAgentService({
  storage,
  events,
  skills,
  mcp,
  models: { has: (model) => settings.hasModel(model) },
})
/** 诊断包（M3-13）：读取日志与事件摘要，统一脱敏后打包；不包含任何凭据。 */
const diagnostics = new DiagnosticsService({
  getAppVersion: () => app.getVersion(),
  getElectronVersion: () => process.versions.electron ?? '',
  getSettings: async () => settings.get(),
  getMcpServers: async () => mcp.list({}).servers,
  getSession: async (sessionId) => {
    const session = storage.sessions.get(sessionId)
    if (!session) return undefined
    const persisted = events
      .readAfter(sessionId, 0)
      .map((event) => event as unknown as Record<string, unknown>)
    return { title: session.title, events: persisted }
  },
  getMainLogs: () => readLogFile(join(paths.logs, 'main.log')),
  getHostLogs: () => readLogFile(join(paths.logs, 'host.log')),
  showSaveDialog: async (defaultName) => {
    // 端到端测试：指定目录时跳过系统保存对话框（不弹出原生窗口）
    const override = process.env['CAIRN_DIAGNOSTICS_DIR']?.trim()
    if (override) return join(override, defaultName)
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    return result.canceled ? undefined : result.filePath
  },
  showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
  userHomeDir: homedir(),
  getKnownSecrets: () => credentials.knownSecrets(),
})
/** 上下文压缩的摘要（M3-03）：宿主经 `host.summarize` 调用，用量记在主进程。 */
const compaction = createCompactService({
  events,
  settings,
  credentials,
  onError: reportError,
})
const supervisor = createHostSupervisor({
  spawn: createUtilityHostSpawner({
    entry: join(import.meta.dirname, 'agent-host.js'),
    fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
    createMessageChannel: () => new MessageChannelMain(),
    env: hostEnvironment(process.env, app.isPackaged),
  }),
  events,
  // 凭据引用由提供方配置给出；没有配置或没有引用时不传凭据
  resolveCredential: async (model) => {
    const ref = settings.credentialRef(model)
    return ref === undefined ? undefined : credentials.resolve(ref)
  },
  resolveModelConfig: (model) => settings.hostModelConfig(model),
  resolvePermissionRules: (sessionId, agent) =>
    trials
      ? trials.permissionRulesFor(sessionId, agent, permissions.rulesForSession(sessionId))
      : agents.permissionRulesFor(agent, permissions.rulesForSession(sessionId)),
  // 自定义说明（M1-13b）：加入系统提示词；修改后在下次启动宿主时生效
  resolveInstructions: () => settings.instructions(),
  // 默认 Shell（M2-09）：同样在下次启动宿主时生效
  resolveShell: () => settings.shell(),
  // 检查点（M1-12b）：每个项目一个影子仓库，会话各用自己的引用
  resolveCheckpoints: (sessionId) => checkpointLocation(paths.checkpoints, storage, sessionId),
  requestApproval: (sessionId, runId, request) => approvals.request(sessionId, runId, request),
  cancelApproval: (sessionId, approvalId) => approvals.cancel(sessionId, approvalId),
  recordChange: (sessionId, runId, input) => changes.record(sessionId, runId, input),
  recordSnapshot: (sessionId, snapshot) => {
    inspect.record(sessionId, snapshot)
  },
  // 项目说明（M3-02）：每轮按项目开关读一次 AGENTS.md。关了就不读。
  loadAgentsMd: (sessionId) => {
    const session = storage.sessions.get(sessionId)
    const project = session && storage.projects.get(session.projectId)
    if (!project) return undefined
    try {
      return loadProjectAgentsMd(project)
    } catch (error) {
      reportError(error)
      return undefined
    }
  },
  summarize: (sessionId, transcript) => compaction.summarize(sessionId, transcript),
  sessionBrief: (sessionId) => latestBrief(events.readAfter(sessionId, 0))?.content,
  loadSkills: (sessionId, agent) => agents.skillsFor(agent, sessionId),
  resolveMcpTools: (_sessionId, agent) => agents.mcpToolsFor(agent),
  resolveAgentDefinition: (agent) => agents.definition(agent),
  // 委派目标（M4-02）：已发布定义、模型、凭据、工具与工作区方式。凭据只经私有接口传回宿主内存。
  resolveDelegation: async (sessionId, agentId) => {
    const definition = agents.get({ agentId }).published
    if (!definition) return undefined
    const session = storage.sessions.get(sessionId)
    const sessionModel = session?.model ?? settings.get().defaultModel
    const model =
      (definition.model.mode === 'fixed' ? definition.model.primary : undefined) ?? sessionModel
    if (!model) return undefined
    const ref = { id: definition.id, version: definition.version }
    const credentialRef = settings.credentialRef(model)
    const credential =
      credentialRef === undefined ? undefined : await credentials.resolve(credentialRef)
    const modelConfig = settings.hostModelConfig(model)
    return {
      definition,
      model,
      ...(credential ? { credential: { apiKey: credential.apiKey } } : {}),
      ...(modelConfig ? { modelConfig } : {}),
      permissionRules: agents.permissionRulesFor(ref, permissions.rulesForSession(sessionId)),
      skills: agents.skillsFor(ref, sessionId),
      mcpTools: agents.mcpToolsFor(ref),
      // 写入类目标可以在隔离工作区中运行（M4-08）；宿主按委派策略决定是否真的隔离。
      workspace: definition.permissions === 'read-only' ? 'shared' : 'isolated',
    }
  },
  resolveDelegateTargets: (_sessionId, agentIds) =>
    agentIds.flatMap((id) => {
      const published = agents.get({ agentId: id }).published
      if (!published) return []
      const name = published.name['zh-CN'] ?? published.name['en-US'] ?? id
      const description = published.description['zh-CN'] ?? published.description['en-US'] ?? ''
      return [{ id, name, description, permissions: published.permissions }]
    }),
  createIsolatedWorkspace: async (input) => {
    const location =
      input.gitDir !== undefined
        ? { gitDir: input.gitDir }
        : checkpointLocation(paths.checkpoints, storage, input.sessionId)
    if (!location) throw new Error('no checkpoint location for the session')
    const workspace = await workspaces.createIsolated({
      projectPath: input.projectPath,
      gitDir: location.gitDir,
      baseCommit: input.baseCommit,
      sessionId: input.sessionId,
      runId: input.runId,
    })
    return {
      path: workspace.path,
      mode: workspace.mode,
      sharedDirs: [...workspace.sharedDirs],
      checkpoint: workspace.checkpoint,
    }
  },
  cleanupWorkspace: async (runId) => {
    await commandService.stopRun(runId)
    return workspaces.cleanup(runId)
  },
  startCommand: (sessionId, input) => commandService.start({ sessionId, ...input }),
  createChangeSet: (sessionId, input) =>
    changeSets.create({
      sessionId,
      runId: input.runId,
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    }),
  callMcpTool: (_sessionId, serverId, toolName, input, maxOutputTokens) =>
    mcp.call(serverId, toolName, input, maxOutputTokens),
  onError: reportError,
})
const sessions = createSessionManager({
  storage,
  events,
  supervisor,
  runDefaults: RUN_DEFAULTS,
  resolveAgent: (agent) => agents.definition(agent),
  models: { defaultModel: () => settings.get().defaultModel, has: settings.hasModel },
  isLocked: (sessionId) => changes.isReverting(sessionId) || checkpoints.isRestoring(sessionId),
  summarize: (sessionId, transcript) => compaction.summarize(sessionId, transcript),
  contextBudget: (sessionId) => {
    const session = storage.sessions.get(sessionId)
    const model = session?.model ?? settings.get().defaultModel
    const config = model ? settings.hostModelConfig(model) : undefined
    return {
      contextWindow: config?.profile.contextWindow ?? 128_000,
      maxOutputTokens: config?.profile.maxOutputTokens ?? 4_096,
      overheadTokens: 0,
    }
  },
  onError: reportError,
})
const trials = createTrialService({ storage, events, agents, sessions })
sessions.recoverInterrupted()
/** 会话要点（M3-04）：每轮结束后用辅助模型增量更新，失败只写日志。 */
const briefs = createBriefService({
  events,
  settings,
  credentials,
  onError: reportError,
})
/** 自动标题（M3-01）：第一轮结束后用辅助模型生成，失败只写日志。 */
const titles = createTitleService({
  events,
  storage,
  settings,
  credentials,
  onError: reportError,
})
/** 项目（M1-16a）：系统的选择文件夹对话框（e2e 中替换 `dialog.showOpenDialog`）。 */
const projects = createProjectService({
  storage,
  pickDirectory: async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  },
})
const gateway = createRendererGateway({
  events,
  commands: sessions,
  projects,
  settings: {
    get: () => settings.get(),
    // 切换权限模式后，运行中的宿主改用新的预设
    update: (patch) => {
      const next = settings.update(patch)
      if (patch.permissionMode !== undefined) sessions.refreshPermissions()
      if (patch.theme !== undefined) nativeTheme.themeSource = patch.theme
      return next
    },
    shell: createShellInfo(),
  },
  credentials: createCredentialCommands(credentials),
  providers: createProviderService({ credentials }),
  // 权限规则（M2-11）：增删之后运行中的宿主立即改用新规则
  permissions: {
    list: () => ({ rules: permissions.listRules() }),
    add: ({ rule, projectId }) => {
      const entry = permissions.addUserRule(rule, projectId)
      sessions.refreshPermissions()
      return entry
    },
    delete: ({ ruleId }) => {
      permissions.deleteRule(ruleId)
      sessions.refreshPermissions()
      return {}
    },
  },
  changes,
  checkpoints,
  changeSets,
  approvals,
  activity,
  backgroundCommands: commandService,
  skills,
  mcp,
  agents,
  trials,
  diagnostics,
  inspect: {
    inspect: (params) =>
      inspect.inspect({
        sessionId: params.sessionId,
        ...(params.runId ? { runId: params.runId } : {}),
      }),
  },
  mcpStatus: (listener) => {
    mcpStatusListeners.add(listener)
    return () => mcpStatusListeners.delete(listener)
  },
  onProtocolError: (error) => reportError(error),
})
/** 活动中心系统通知（M4-06）：只在所有窗口都不在前台时发送，按会话合并。 */
const activityNotifier = createActivityNotifier({
  activity,
  isForeground: () =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible() && window.isFocused()),
  enabled: () => settings.get().activityNotifications !== false,
  format: ({ kind, title, agentId }) => {
    const english = settings.get().locale === 'en-US'
    let agentName = agentId
    try {
      const definition = agents.get({ agentId }).published
      agentName =
        definition?.name[english ? 'en-US' : 'zh-CN'] ?? definition?.name['en-US'] ?? agentId
    } catch {
      // 定义已删除时仍用 id，通知本身不应失败。
    }
    return {
      title: title || agentName,
      body:
        kind === 'approval'
          ? english
            ? `${agentName} · Approval needed`
            : `${agentName} · 需要审批`
          : english
            ? `${agentName} · Run completed`
            : `${agentName} · 运行已完成`,
    }
  },
  notify: ({ title, body, sessionId }) => {
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({ title, body })
      notification.on('click', () => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        gateway.openActivitySession(sessionId)
      })
      notification.show()
    } catch (error) {
      reportError(error)
    }
  },
  onError: reportError,
})

// 对所有 WebContents（含将来的子窗口、DevTools 之外的页面）拦截导航、新窗口与 <webview>
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents as unknown as WebContentsLike, {
    policy: navigationPolicy,
    openExternal: (url) => void shell.openExternal(url),
  })
})

/** 系统主题跟随设置（M2-02）：界面的 prefers-color-scheme 与系统按钮的颜色都随之变化。 */
/** 以 `--ozone-platform=headless` 运行（冒烟测试）。 */
const headless = (): boolean => app.commandLine.getSwitchValue('ozone-platform') === 'headless'

function followThemeSetting(): void {
  nativeTheme.themeSource = settings.get().theme ?? 'system'
  nativeTheme.on('updated', () => {
    if (!usesTitleBarOverlay(process.platform, headless())) return
    const overlay = titleBarOverlay(nativeTheme.shouldUseDarkColors)
    for (const window of BrowserWindow.getAllWindows()) window.setTitleBarOverlay(overlay)
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    ...windowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors, headless()),
    webPreferences: secureWebPreferences(join(import.meta.dirname, '../preload/index.cjs')),
  })
  const connection = gateway.connect(
    createRendererChannel({
      ipcMain,
      contents: window.webContents,
      policy: navigationPolicy,
      onRejected: (reason, url) => reportError(new Error(`IPC rejected (${reason}): ${url}`)),
    }),
  )
  window.once('closed', () => connection.close())
  window.once('ready-to-show', () => window.show())
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(rendererFile)
  return window
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前停止所有宿主（各自收到 host.shutdown），再关闭数据库
let servicesClosed = false
app.on('before-quit', (event) => {
  if (servicesClosed) return
  event.preventDefault()
  servicesClosed = true
  titles.stop()
  briefs.stop()
  compaction.stop()
  activityNotifier.close()
  gateway.close()
  void mcp.close()
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
  void Promise.race([Promise.all([sessions.shutdown(), commandService.shutdown()]), timeout])
    .catch(reportError)
    .finally(() => {
      storage.close()
      app.quit()
    })
})

/** 冒烟检查（`CAIRN_SMOKE=1`）的 Electron 部分，流程见 `smoke.ts`。 */
function startSmoke(window: BrowserWindow): void {
  const { webContents } = window
  void runSmokeChecks({
    waitForLoad: () =>
      webContents.isLoading()
        ? new Promise((resolve) => webContents.once('did-finish-load', () => resolve()))
        : Promise.resolve(),
    probeRenderer: async () =>
      (await webContents.executeJavaScript(RENDERER_PROBE_SCRIPT)) as RendererProbe,
    runTurn: () =>
      new Promise((resolve, reject) => {
        const { sessionId } = sessions.create({ projectPath: app.getPath('userData') })
        const off = events.subscribe((id, batch) => {
          if (id !== sessionId) return
          for (const event of batch) {
            if (event.type === 'turn.completed') {
              off()
              resolve()
            } else if (event.type === 'turn.failed' || event.type === 'session.crashed') {
              off()
              reject(new Error(`${event.type}: ${JSON.stringify(event.payload)}`))
            }
          }
        })
        sessions.prompt({ sessionId, content: [{ type: 'text', text: 'smoke' }] })
      }),
    checkCredentials: smokeCredentials,
    credentialsRequired: process.platform !== 'linux',
    checkSearch: () =>
      checkBundledSearch(ripgrepPath, join(app.getPath('userData'), 'smoke-workspace')),
    expectedText: 'Cairn',
    userData: app.getPath('userData'),
    report: (line) => process.stdout.write(`${line}\n`),
    exit: (code) => app.exit(code),
  })
}

/** 用真实的系统加密保存、解析并删除一个测试 Key（冒烟检查，数据目录是临时目录）。 */
async function smokeCredentials(): Promise<CredentialCheck> {
  if (!(await createSafeStorageCipher(safeStorage).isAvailable())) return 'unavailable'
  const ref = 'smoke-test'
  const secret = `smoke-secret-${process.pid}`
  await credentials.set(ref, secret)
  const resolved = await credentials.resolve(ref)
  const onDisk = readFileSync(paths.credentials, 'utf8')
  await credentials.delete(ref)
  if (resolved?.apiKey !== secret) throw new Error('credential store returned a different key')
  if (onDisk.includes(secret)) throw new Error('credential store wrote the key in plain text')
  return 'stored'
}

void app.whenReady().then(() => {
  restrictPermissions(session.defaultSession)
  followThemeSetting()
  void mcp.initialize()
  const window = createWindow()
  if (isSmokeRun(process.env)) startSmoke(window)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
