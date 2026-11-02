/**
 * 启动冒烟检查（M0-12a）。设置 `NEXUS_SMOKE=1` 启动应用时，主进程在窗口加载后检查：
 * - 界面已渲染（根节点文本包含应用名称）；
 * - agent 宿主入口能以 utilityProcess 启动并回报 `host.started`。
 * 结果以 `NEXUS_SMOKE_RESULT <JSON>` 一行输出到标准输出，随后退出（成功 0，失败 1）。
 *
 * 这里只有与 Electron 无关的流程，Electron 相关的操作由入口注入，便于单元测试。
 */

export const SMOKE_ENV = 'NEXUS_SMOKE'
export const SMOKE_RESULT_PREFIX = 'NEXUS_SMOKE_RESULT '
export const DEFAULT_SMOKE_TIMEOUT_MS = 30_000

export interface SmokeResult {
  readonly ok: boolean
  readonly rendererText: string | null
  readonly hostStarted: boolean
  readonly userData: string
  readonly error?: string
}

export interface SmokeDeps {
  /** 窗口内容加载完成。 */
  readonly waitForLoad: () => Promise<void>
  /** 界面根节点的文本。 */
  readonly readRendererText: () => Promise<string | null>
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
  let rendererText: string | null = null
  let hostStarted = false
  let error: string | undefined
  try {
    await withTimeout(deps.waitForLoad(), timeoutMs, 'window load')
    rendererText = await withTimeout(deps.readRendererText(), timeoutMs, 'renderer read')
    if (!rendererText?.includes(deps.expectedText)) {
      throw new Error(`renderer did not show "${deps.expectedText}"`)
    }
    await withTimeout(deps.startHost(), timeoutMs, 'agent host start')
    hostStarted = true
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const result: SmokeResult = {
    ok: error === undefined,
    rendererText,
    hostStarted,
    userData: deps.userData,
    ...(error === undefined ? {} : { error }),
  }
  deps.report(`${SMOKE_RESULT_PREFIX}${JSON.stringify(result)}`)
  deps.exit(result.ok ? 0 : 1)
  return result
}
