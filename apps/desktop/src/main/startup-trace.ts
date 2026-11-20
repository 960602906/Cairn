/**
 * 启动计时（PR0，启动优化）。开发模式或 `CAIRN_STARTUP_TRACE=1` 时记录主进程各阶段耗时，
 * 输出到终端并挂在 `globalThis.__cairnStartup` 供 e2e 读取；关闭时只做一次布尔判断，生产零开销。
 *
 * 时间一律相对本模块求值时刻（进程尽早 import 它），不跨进程做绝对时间相减。
 */
export interface StartupMark {
  readonly name: string
  /** 相对 trace 起点的毫秒数。 */
  readonly at: number
}

export interface StartupMarksSnapshot {
  readonly enabled: boolean
  readonly marks: readonly StartupMark[]
}

const origin = performance.now()
const marks: StartupMark[] = []
let enabled = false

/** 开发版始终记录；打包版只在显式要求时记录。 */
export function shouldTraceStartup(
  env: NodeJS.ProcessEnv = process.env,
  packaged = true,
): boolean {
  return !packaged || env['CAIRN_STARTUP_TRACE'] === '1'
}

export function configureStartupTrace(value: boolean): void {
  enabled = value
  if (!enabled) return
  const target = globalThis as typeof globalThis & {
    __cairnStartup?: { snapshot: () => StartupMarksSnapshot }
  }
  target.__cairnStartup = { snapshot }
}

/** 是否在记录启动计时（开发版或显式开启）；用于跳过只有计时才需要的额外工作。 */
export function isTracing(): boolean {
  return enabled
}

export function mark(name: string): void {
  if (!enabled) return
  const at = performance.now() - origin
  marks.push({ name, at })
  console.info(`[startup] ${name} +${Math.round(at)}ms`)
}

export function snapshot(): StartupMarksSnapshot {
  return { enabled, marks: [...marks] }
}
