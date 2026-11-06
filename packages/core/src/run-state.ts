/**
 * 运行状态机（Runtime §5）。
 *
 * 只描述"哪些转换合法"，不负责触发转换：转换由 RunEngine 内部发起（M0-07c），
 * 每次成功转换后发出 `run.state.changed` 事件。非法转换返回错误而不抛出，
 * 调用方记录日志并忽略，运行不会进入未定义状态（Runtime §5.2）。
 */
import { RunState, type ErrorInfo } from '@cairn/protocol'

/** 全部运行状态，顺序与 protocol 中的定义一致。 */
export const RUN_STATES: readonly RunState[] = RunState.options

/**
 * 运行中状态：一轮正在进行，可被用户停止、因错误失败或因进程退出中断。
 * `aborting` 不在其中：中止已经开始，不能再次停止或失败，只能完成清理或被中断。
 */
export const ACTIVE_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'thinking',
  'tooling',
  'awaiting_approval',
  'awaiting_children',
])

/** 运行中状态的公共出口：用户停止、不可恢复错误 / 超出限额、进程退出。 */
const ACTIVE_EXITS = ['aborting', 'failed', 'interrupted'] as const satisfies readonly RunState[]

/**
 * 合法转换表。
 *
 * - `completed` 表示本轮已结束，行为与 `idle` 相同：可接受新输入，也可被归档。
 * - `failed`（可重试）与 `interrupted`（可恢复）都可直接开始新一轮。
 * - `aborting` 清理完成后回到 `idle`（发出 `turn.aborted`）；清理期间进程退出则为 `interrupted`。
 * - `disposed` 是终态。
 * - 不允许自转换：状态未变时不应发出 `run.state.changed`。
 */
export const RUN_STATE_TRANSITIONS: { readonly [S in RunState]: readonly RunState[] } = {
  idle: ['thinking', 'disposed'],
  thinking: ['tooling', 'completed', ...ACTIVE_EXITS],
  tooling: ['thinking', 'awaiting_approval', 'awaiting_children', ...ACTIVE_EXITS],
  awaiting_approval: ['tooling', ...ACTIVE_EXITS],
  awaiting_children: ['tooling', ...ACTIVE_EXITS],
  completed: ['thinking', 'disposed'],
  aborting: ['idle', 'interrupted'],
  failed: ['thinking', 'disposed'],
  interrupted: ['thinking', 'disposed'],
  disposed: [],
}

/** 非法转换的错误码。 */
export const RunStateErrorCode = {
  InvalidTransition: 'run.invalid_transition',
} as const

export type TransitionResult =
  | { readonly ok: true; readonly state: RunState }
  | { readonly ok: false; readonly error: ErrorInfo }

/** `from` → `to` 是否为合法转换。 */
export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to)
}

/** 尝试转换；非法时返回 `run.invalid_transition` 错误（含 `from`、`to`），不抛出。 */
export function transition(from: RunState, to: RunState): TransitionResult {
  if (canTransition(from, to)) return { ok: true, state: to }
  return { ok: false, error: { code: RunStateErrorCode.InvalidTransition, params: { from, to } } }
}

/** 是否为运行中状态（见 {@link ACTIVE_RUN_STATES}）。 */
export function isActiveRunState(state: RunState): boolean {
  return ACTIVE_RUN_STATES.has(state)
}

/** 是否可以接受新输入、开始新一轮。 */
export function acceptsInput(state: RunState): boolean {
  return canTransition(state, 'thinking') && !isActiveRunState(state)
}
