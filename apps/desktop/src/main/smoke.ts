/**
 * 启动冒烟检查（M0-12）。设置 `CAIRN_SMOKE=1` 启动应用时，主进程在窗口加载后检查：
 * - 界面已渲染（根节点文本包含应用名称）；
 * - 界面中没有 Node 能力（`require`、`process`、`module`、`Buffer` 等均不存在）；
 * - preload 只暴露了 `window.cairn` 的 `on`、`ready`、`request` 三个函数；
 * - 页面带有 CSP，且 CSP 生效（`new Function` 被拒绝）；
 * - 界面经 `window.cairn` 调用 `session.list` 成功（IPC 网关、会话管理器与数据库已接通）；
 * - 新建会话并发送一条输入，agent 宿主（utilityProcess + 专用端口 + FakeRuntime）完成一轮对话；
 * - 凭据存储用真实的系统加密（`safeStorage`）保存、解析并删除一个测试 Key（M1-03a）。系统加密不可用时
 *   （Linux 无密钥环，如 CI 容器）记为 `unavailable`；Windows 与 macOS 上要求可用。
 * - 随应用打包的 ripgrep 能找到并运行，`search` 工具能在临时工作区中找到内容（M1-07b）。
 * 结果以 `CAIRN_SMOKE_RESULT <JSON>` 一行输出到标准输出，随后退出（成功 0，失败 1）。
 *
 * 这里只有与 Electron 无关的流程，Electron 相关的操作由入口注入，便于单元测试。
 */

export const SMOKE_ENV = 'CAIRN_SMOKE'
export const SMOKE_RESULT_PREFIX = 'CAIRN_SMOKE_RESULT '
export const DEFAULT_SMOKE_TIMEOUT_MS = 30_000

/** 在界面中执行 `RENDERER_PROBE_SCRIPT` 得到的结果。 */
export interface RendererProbe {
  readonly text: string | null
  /** 界面中存在的 Node 全局变量，应为空。 */
  readonly nodeGlobals: readonly string[]
  /** `window.cairn` 的属性名与类型。 */
  readonly api: Readonly<Record<string, string>> | null
  readonly csp: string | null
  /** CSP 生效时 `new Function` 被拒绝。 */
  readonly evalBlocked: boolean
  /** 经 `window.cairn` 请求 `session.list` 的结果：成功为 null，失败为错误码或说明。 */
  readonly ipcError: string | null
}

/** 在界面中执行的检查脚本（`webContents.executeJavaScript`），返回 `RendererProbe`。 */
export const RENDERER_PROBE_SCRIPT = `(async () => {
  const nodeGlobals = ['require', 'process', 'module', 'exports', 'Buffer', 'global', '__dirname']
    .filter((name) => typeof globalThis[name] !== 'undefined')
  const cairn = globalThis.cairn
  const api = cairn ? Object.fromEntries(Object.keys(cairn).sort().map((k) => [k, typeof cairn[k]])) : null
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  let evalBlocked = false
  try { new Function('return 1')() } catch { evalBlocked = true }
  let ipcError = 'window.cairn is missing'
  if (cairn) {
    const ready = await cairn.ready()
    const listed = ready.ok ? await cairn.request('session.list', {}) : ready
    ipcError = listed.ok ? null : listed.error.code
  }
  return {
    text: document.getElementById('root')?.textContent ?? null,
    nodeGlobals,
    api,
    csp: meta ? meta.getAttribute('content') : null,
    evalBlocked,
    ipcError,
  }
})()`

const EXPECTED_API = { on: 'function', ready: 'function', request: 'function' }

/** 检查界面的探测结果，返回发现的问题。 */
export function checkRendererProbe(probe: RendererProbe, expectedText: string): string[] {
  const problems: string[] = []
  if (!probe.text?.includes(expectedText)) problems.push(`renderer did not show "${expectedText}"`)
  if (probe.nodeGlobals.length > 0) {
    problems.push(`renderer has Node globals: ${probe.nodeGlobals.join(', ')}`)
  }
  if (JSON.stringify(probe.api) !== JSON.stringify(EXPECTED_API)) {
    problems.push(`unexpected preload API: ${JSON.stringify(probe.api)}`)
  }
  if (!probe.csp?.includes("script-src 'self'")) problems.push('renderer has no CSP')
  if (!probe.evalBlocked) problems.push('CSP does not block eval')
  if (probe.ipcError !== null) problems.push(`session.list over IPC failed: ${probe.ipcError}`)
  return problems
}

export interface SmokeResult {
  readonly ok: boolean
  readonly renderer: RendererProbe | null
  readonly turnCompleted: boolean
  /** 凭据存储检查的结果；没有执行到时为 null。 */
  readonly credentials: CredentialCheck | null
  /** `search` 检查通过时为 ripgrep 的版本（`rg --version` 的第一行）；没有执行到时为 null。 */
  readonly search: string | null
  readonly userData: string
  readonly error?: string
}

/** `stored`：用系统加密保存并解析成功；`unavailable`：系统加密不可用。 */
export type CredentialCheck = 'stored' | 'unavailable'

export interface SmokeDeps {
  /** 窗口内容加载完成。 */
  readonly waitForLoad: () => Promise<void>
  /** 在界面中执行 `RENDERER_PROBE_SCRIPT`。 */
  readonly probeRenderer: () => Promise<RendererProbe>
  /** 新建会话、发送输入，宿主完成一轮（`turn.completed`）后 resolve。 */
  readonly runTurn: () => Promise<void>
  /** 保存、解析并删除一个测试 Key；结果不一致时抛出。 */
  readonly checkCredentials: () => Promise<CredentialCheck>
  /** 系统加密必须可用（Windows、macOS）。 */
  readonly credentialsRequired: boolean
  /** 用打包的 ripgrep 执行一次 `search`，返回 ripgrep 版本；找不到、无法运行或结果不对时抛出。 */
  readonly checkSearch: () => Promise<string>
  /** 界面应显示的文本（应用名称）。 */
  readonly expectedText: string
  readonly userData: string
  readonly report: (line: string) => void
  readonly exit: (code: number) => void
  readonly timeoutMs?: number
}

export function isSmokeRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SMOKE_ENV] === '1'
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** 依次执行检查，输出结果并退出。不会抛出。 */
export async function runSmokeChecks(deps: SmokeDeps): Promise<SmokeResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS
  let renderer: RendererProbe | null = null
  let turnCompleted = false
  let credentials: CredentialCheck | null = null
  let search: string | null = null
  let error: string | undefined
  try {
    await withTimeout(deps.waitForLoad(), timeoutMs, 'window load')
    renderer = await withTimeout(deps.probeRenderer(), timeoutMs, 'renderer probe')
    const problems = checkRendererProbe(renderer, deps.expectedText)
    if (problems.length > 0) throw new Error(problems.join('; '))
    await withTimeout(deps.runTurn(), timeoutMs, 'conversation turn')
    turnCompleted = true
    credentials = await withTimeout(deps.checkCredentials(), timeoutMs, 'credential store')
    if (credentials === 'unavailable' && deps.credentialsRequired) {
      throw new Error('system encryption (safeStorage) is unavailable')
    }
    search = await withTimeout(deps.checkSearch(), timeoutMs, 'search with bundled ripgrep')
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const result: SmokeResult = {
    ok: error === undefined,
    renderer,
    turnCompleted,
    credentials,
    search,
    userData: deps.userData,
    ...(error === undefined ? {} : { error }),
  }
  deps.report(`${SMOKE_RESULT_PREFIX}${JSON.stringify(result)}`)
  deps.exit(result.ok ? 0 : 1)
  return result
}
