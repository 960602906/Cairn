/**
 * 启动冒烟检查（M0-12）。设置 `NEXUS_SMOKE=1` 启动应用时，主进程在窗口加载后检查：
 * - 界面已渲染（根节点文本包含应用名称）；
 * - 界面中没有 Node 能力（`require`、`process`、`module`、`Buffer` 等均不存在）；
 * - preload 只暴露了 `window.nexus` 的 `on`、`ready`、`request` 三个函数；
 * - 页面带有 CSP，且 CSP 生效（`new Function` 被拒绝）；
 * - agent 宿主入口能以 utilityProcess 启动并回报 `host.started`。
 * 结果以 `NEXUS_SMOKE_RESULT <JSON>` 一行输出到标准输出，随后退出（成功 0，失败 1）。
 *
 * 这里只有与 Electron 无关的流程，Electron 相关的操作由入口注入，便于单元测试。
 */

export const SMOKE_ENV = 'NEXUS_SMOKE'
export const SMOKE_RESULT_PREFIX = 'NEXUS_SMOKE_RESULT '
export const DEFAULT_SMOKE_TIMEOUT_MS = 30_000

/** 在界面中执行 `RENDERER_PROBE_SCRIPT` 得到的结果。 */
export interface RendererProbe {
  readonly text: string | null
  /** 界面中存在的 Node 全局变量，应为空。 */
  readonly nodeGlobals: readonly string[]
  /** `window.nexus` 的属性名与类型。 */
  readonly api: Readonly<Record<string, string>> | null
  readonly csp: string | null
  /** CSP 生效时 `new Function` 被拒绝。 */
  readonly evalBlocked: boolean
}

/** 在界面中执行的检查脚本（`webContents.executeJavaScript`），返回 `RendererProbe`。 */
export const RENDERER_PROBE_SCRIPT = `(() => {
  const nodeGlobals = ['require', 'process', 'module', 'exports', 'Buffer', 'global', '__dirname']
    .filter((name) => typeof globalThis[name] !== 'undefined')
  const nexus = globalThis.nexus
  const api = nexus ? Object.fromEntries(Object.keys(nexus).sort().map((k) => [k, typeof nexus[k]])) : null
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  let evalBlocked = false
  try { new Function('return 1')() } catch { evalBlocked = true }
  return {
    text: document.getElementById('root')?.textContent ?? null,
    nodeGlobals,
    api,
    csp: meta ? meta.getAttribute('content') : null,
    evalBlocked,
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
  return problems
}

export interface SmokeResult {
  readonly ok: boolean
  readonly renderer: RendererProbe | null
  readonly hostStarted: boolean
  readonly userData: string
  readonly error?: string
}

export interface SmokeDeps {
  /** 窗口内容加载完成。 */
  readonly waitForLoad: () => Promise<void>
  /** 在界面中执行 `RENDERER_PROBE_SCRIPT`。 */
  readonly probeRenderer: () => Promise<RendererProbe>
  /** 启动 agent 宿主，收到 `host.started` 后完成。 */
  readonly startHost: () => Promise<void>
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
  let hostStarted = false
  let error: string | undefined
  try {
    await withTimeout(deps.waitForLoad(), timeoutMs, 'window load')
    renderer = await withTimeout(deps.probeRenderer(), timeoutMs, 'renderer probe')
    const problems = checkRendererProbe(renderer, deps.expectedText)
    if (problems.length > 0) throw new Error(problems.join('; '))
    await withTimeout(deps.startHost(), timeoutMs, 'agent host start')
    hostStarted = true
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const result: SmokeResult = {
    ok: error === undefined,
    renderer,
    hostStarted,
    userData: deps.userData,
    ...(error === undefined ? {} : { error }),
  }
  deps.report(`${SMOKE_RESULT_PREFIX}${JSON.stringify(result)}`)
  deps.exit(result.ok ? 0 : 1)
  return result
}
