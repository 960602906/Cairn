/**
 * 主进程入口（ADR-0002、ADR-0003，架构 §4、§17）。只做启动引导：确定数据目录、应用安全基线、
 * 组装主进程服务（存储、设置、宿主管理、IPC 网关）、创建窗口。服务本身不依赖 Electron，见 `services/`。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openShadowRepo } from '@cairn/checkpoint'
import { redact } from '@cairn/core'
import { bundledRipgrepPath } from '@cairn/tools'
import { openSqliteStorage } from '@cairn/storage'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron'
import { requiredDirectories, resolveAppPaths } from './app-paths.js'
import {
  hardenWebContents,
  restrictPermissions,
  secureWebPreferences,
  type NavigationPolicy,
  type WebContentsLike,
} from './security.js'
import { createBlobStore } from './services/blob-store.js'
import { createChangeService } from './services/change-service.js'
import { createCheckpointService } from './services/checkpoint-service.js'
import { checkpointLocation } from './services/checkpoint-location.js'
import { createCredentialCommands, createLocalKeyStore } from './services/credential-store.js'
import { createSessionEventService } from './services/event-service.js'
import { createUtilityHostSpawner } from './services/host-process.js'
import { createHostSupervisor } from './services/host-supervisor.js'
import { createProjectService } from './services/project-service.js'
import { createRendererGateway } from './services/renderer-gateway.js'
import { createRendererChannel } from './services/renderer-transport.js'
import { createApprovalService } from './services/approval-service.js'
import { createPermissionService } from './services/permission-service.js'
import { createSessionManager, type RunDefaults } from './services/session-manager.js'
import { createSafeStorageCipher } from './services/safe-storage-cipher.js'
import { createSettingsService } from './services/settings-service.js'
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
  agent: { id: 'default', version: 1 },
  model: { providerId: 'fake', modelId: 'fake' },
  mode: 'interactive',
  limits: { maxStepsPerTurn: 50, maxTurnDurationMs: 10 * 60_000, maxConsecutiveToolErrors: 5 },
}
/** 退出时等待宿主结束的上限。 */
const SHUTDOWN_TIMEOUT_MS = 5_000

/** 已保存或解析过的 Key（凭据存储创建后接上），错误输出前按原文脱敏。 */
let knownSecrets: () => readonly string[] = () => []
// 日志服务接入前，异常先写到标准错误（经过脱敏）
const reportError = (error: unknown) =>
  console.error('[cairn]', redact(error, { homeDirs: [homedir()], secrets: knownSecrets() }))

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
/** 改动记录（M1-08b）：宿主报告的改动写入 blob 存储与数据库；界面列出与撤销。 */
const changes = createChangeService({
  storage,
  blobs: createBlobStore(paths.blobs),
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
/** 权限规则（M1-10c）：权限模式的预设与保存的规则，启动宿主时经 `host.init` 下发。 */
const permissions = createPermissionService({ storage, mode: () => settings.permissionMode() })
/** 审批（M1-11b）：宿主的审批请求等待界面决定；“始终允许”生成的规则通知所有运行中的宿主。 */
const approvals = createApprovalService({
  permissions,
  onRuleAdded: () => sessions.refreshPermissions(),
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
  resolvePermissionRules: (sessionId) => permissions.rulesForSession(sessionId),
  // 自定义说明（M1-13b）：加入系统提示词；修改后在下次启动宿主时生效
  resolveInstructions: () => settings.instructions(),
  // 检查点（M1-12b）：每个项目一个影子仓库，会话各用自己的引用
  resolveCheckpoints: (sessionId) => checkpointLocation(paths.checkpoints, storage, sessionId),
  requestApproval: (sessionId, runId, request) => approvals.request(sessionId, runId, request),
  cancelApproval: (sessionId, approvalId) => approvals.cancel(sessionId, approvalId),
  recordChange: (sessionId, runId, input) => changes.record(sessionId, runId, input),
  onError: reportError,
})
const sessions = createSessionManager({
  storage,
  events,
  supervisor,
  runDefaults: RUN_DEFAULTS,
  models: { defaultModel: () => settings.get().defaultModel, has: settings.hasModel },
  isLocked: (sessionId) => changes.isReverting(sessionId) || checkpoints.isRestoring(sessionId),
  onError: reportError,
})
sessions.recoverInterrupted()
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
      return next
    },
  },
  credentials: createCredentialCommands(credentials),
  changes,
  checkpoints,
  approvals,
  onProtocolError: (error) => reportError(error),
})

// 对所有 WebContents（含将来的子窗口、DevTools 之外的页面）拦截导航、新窗口与 <webview>
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents as unknown as WebContentsLike, {
    policy: navigationPolicy,
    openExternal: (url) => void shell.openExternal(url),
  })
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
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
  gateway.close()
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
  void Promise.race([sessions.shutdown(), timeout])
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
  const window = createWindow()
  if (isSmokeRun(process.env)) startSmoke(window)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
