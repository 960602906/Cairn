/**
 * FakeRuntime：按脚本输出的 `AgentRuntime` 实现（ADR-0004；Runtime §17）。
 *
 * 不调用任何模型，用于单元测试、界面开发与端到端测试（M0-14～M0-16）。
 * 每次 `prompt` 取脚本中的下一轮；一轮由若干步骤组成，每步对应一次"模型调用"：
 *
 * - `tool`：流式输出可选的推理与文本，请求一次工具调用，经 `hooks` 放行与执行后进入下一步；
 * - `tools`：同上，一次请求多个工具调用。与 pi 相同（Runtime §6.2）：全部是可并行的工具（`parallel`）时
 *   并行执行，否则按顺序执行；结果按调用顺序进入历史；
 *   调用带 `rejectedWith`（错误码）时模拟运行时自己拒绝的调用（工具不存在、参数非法）：不经 `hooks` 执行，
 *   经 `hooks.toolCallRejected` 报告，错误作为工具结果进入历史；
 * - `reply`：流式输出推理与文本，作为最终回复结束本轮；
 * - `fail`：模拟模型请求失败，以 `loop.ended { outcome: 'failed' }` 结束循环。之后 `retry()` 从下一步继续；
 *   `fail` 是最后一步时，`retry()` 再次以同样的失败结束（持续失败）。
 *
 * 脚本用尽后，回声回复用户输入。文本按 `chunkSize` 切分为增量，每个增量之前等待 `delayMs`；
 * 期间收到中止（`abort()` 或 `init.signal`）时，以 `aborted` 结束本步与本轮，未完成的消息不进入历史。
 */
import type { CanonicalMessage, ContentPart, ErrorInfo, TokenUsage } from '@nexus/protocol'
import type {
  AbortSignalLike,
  AgentRuntime,
  AssistantMessage,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionInit,
  RuntimeToolCall,
  RuntimeToolResult,
  UserMessage,
} from './runtime.js'

export type FakeStep =
  | {
      readonly kind: 'reply'
      readonly text: string
      readonly reasoning?: string
      readonly usage?: TokenUsage
    }
  | {
      readonly kind: 'tool'
      readonly name: string
      readonly input: unknown
      readonly rejectedWith?: string
      readonly text?: string
      readonly reasoning?: string
      readonly usage?: TokenUsage
    }
  | {
      readonly kind: 'tools'
      readonly calls: readonly FakeToolCall[]
      readonly text?: string
      readonly reasoning?: string
      readonly usage?: TokenUsage
    }
  | { readonly kind: 'fail'; readonly error: ErrorInfo; readonly retryable: boolean }

export interface FakeToolCall {
  readonly name: string
  readonly input: unknown
  /** 运行时拒绝这次调用时的错误码，如 `tool.not_found`、`tool.invalid_input`。 */
  readonly rejectedWith?: string
}

export interface FakeTurn {
  readonly steps: readonly FakeStep[]
}

export interface FakeScript {
  readonly turns: readonly FakeTurn[]
  /** 每个增量的字符数，默认 1（逐字）。 */
  readonly chunkSize?: number
  /** 每个增量之前的等待毫秒数，默认 0（不等待，也不让出事件循环）。 */
  readonly delayMs?: number
}

export type FakeScriptResult =
  | { readonly ok: true; readonly script: FakeScript }
  | { readonly ok: false; readonly errors: readonly string[] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

function checkUsage(v: unknown, at: string, errors: string[]): void {
  if (v === undefined) return
  if (!isRecord(v) || !isNonNegInt(v.inputTokens) || !isNonNegInt(v.outputTokens)) {
    errors.push(`${at}.usage: 需要非负整数 inputTokens 与 outputTokens`)
  }
}

function checkOptionalString(v: unknown, at: string, errors: string[]): void {
  if (v !== undefined && typeof v !== 'string') errors.push(`${at}: 必须是字符串`)
}

/**
 * 校验脚本（例如端到端测试从 JSON 读入的脚本）。
 * 规则：每轮至少一步；`reply` 只能是最后一步，`tool`、`tools` 不能是最后一步；`fail` 之后的步骤在
 * `retry()` 时执行。
 */
export function parseFakeScript(input: unknown): FakeScriptResult {
  const errors: string[] = []
  if (!isRecord(input)) return { ok: false, errors: ['脚本必须是对象'] }
  if (input.chunkSize !== undefined && !(isNonNegInt(input.chunkSize) && input.chunkSize > 0)) {
    errors.push('chunkSize: 必须是正整数')
  }
  if (input.delayMs !== undefined && !isNonNegInt(input.delayMs)) {
    errors.push('delayMs: 必须是非负整数')
  }
  if (!Array.isArray(input.turns)) {
    errors.push('turns: 必须是数组')
  } else {
    input.turns.forEach((turn: unknown, t) => {
      const at = `turns[${t}]`
      if (!isRecord(turn) || !Array.isArray(turn.steps) || turn.steps.length === 0) {
        errors.push(`${at}.steps: 必须是非空数组`)
        return
      }
      const steps: unknown[] = turn.steps
      steps.forEach((step, s) => {
        const sat = `${at}.steps[${s}]`
        const last = s === steps.length - 1
        if (!isRecord(step)) {
          errors.push(`${sat}: 必须是对象`)
          return
        }
        switch (step.kind) {
          case 'reply':
            if (typeof step.text !== 'string') errors.push(`${sat}.text: 必须是字符串`)
            checkOptionalString(step.reasoning, `${sat}.reasoning`, errors)
            checkUsage(step.usage, sat, errors)
            if (!last) errors.push(`${sat}: reply 只能是最后一步`)
            break
          case 'tool':
            if (typeof step.name !== 'string' || step.name === '') {
              errors.push(`${sat}.name: 必须是非空字符串`)
            }
            if (!('input' in step)) errors.push(`${sat}.input: 缺失`)
            checkOptionalString(step.rejectedWith, `${sat}.rejectedWith`, errors)
            checkOptionalString(step.text, `${sat}.text`, errors)
            checkOptionalString(step.reasoning, `${sat}.reasoning`, errors)
            checkUsage(step.usage, sat, errors)
            if (last) errors.push(`${sat}: tool 不能是最后一步`)
            break
          case 'tools':
            if (!Array.isArray(step.calls) || step.calls.length === 0) {
              errors.push(`${sat}.calls: 必须是非空数组`)
            } else {
              step.calls.forEach((c: unknown, i) => {
                if (
                  !isRecord(c) ||
                  typeof c.name !== 'string' ||
                  c.name === '' ||
                  !('input' in c)
                ) {
                  errors.push(`${sat}.calls[${i}]: 需要非空 name 与 input`)
                } else {
                  checkOptionalString(c.rejectedWith, `${sat}.calls[${i}].rejectedWith`, errors)
                }
              })
            }
            checkOptionalString(step.text, `${sat}.text`, errors)
            checkOptionalString(step.reasoning, `${sat}.reasoning`, errors)
            checkUsage(step.usage, sat, errors)
            if (last) errors.push(`${sat}: tools 不能是最后一步`)
            break
          case 'fail':
            if (
              !isRecord(step.error) ||
              typeof step.error.code !== 'string' ||
              step.error.code === ''
            ) {
              errors.push(`${sat}.error.code: 必须是非空字符串`)
            }
            if (typeof step.retryable !== 'boolean') errors.push(`${sat}.retryable: 必须是布尔值`)
            break
          default:
            errors.push(`${sat}.kind: 必须是 reply、tool、tools 或 fail`)
        }
      })
    })
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, script: input as unknown as FakeScript }
}

export interface FakeRuntimeOptions {
  /** 时间来源，默认 `Date.now`。 */
  readonly now?: () => number
}

type TimerHandle = { readonly __timer: unique symbol }
/** core 不引入 DOM / Node 类型；计时器每次从 globalThis 读取，测试中的假计时器也能生效。 */
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** 抛出以结束当前轮次。 */
class Aborted {}

/** 每轮一个的中止信号；传给 `executeTool`，使工具也能感知中止。 */
class TurnSignal implements AbortSignalLike {
  aborted = false
  readonly #listeners = new Set<() => void>()

  addEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.add(listener)
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.delete(listener)
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    for (const listener of [...this.#listeners]) listener()
    this.#listeners.clear()
  }
}

function chunks(text: string, size: number): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

const textOf = (content: readonly ContentPart[]) =>
  content.map((p) => (p.type === 'text' ? p.text : '')).join('')

export class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  readonly #script: FakeScript
  readonly #now: () => number

  constructor(script: FakeScript = { turns: [] }, options: FakeRuntimeOptions = {}) {
    const parsed = parseFakeScript(script)
    if (!parsed.ok) throw new Error(`FakeRuntime 脚本无效：${parsed.errors.join('；')}`)
    this.#script = parsed.script
    this.#now = options.now ?? (() => Date.now())
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    return new FakeSession(init, this.#script, this.#now)
  }
}

class FakeSession implements RuntimeSession {
  readonly #init: RuntimeSessionInit
  readonly #script: FakeScript
  readonly #now: () => number
  readonly #listeners = new Set<(event: RuntimeEvent) => void>()
  readonly #history: CanonicalMessage[]
  #turnIndex = 0
  /** 上一次循环以 `fail` 结束时，`retry()` 从这里继续。 */
  #resume: { readonly turn: FakeTurn; readonly next: number } | undefined
  #callCounter = 0
  /** 当前轮次的中止信号；空闲时为 undefined。 */
  #running: TurnSignal | undefined
  /** 当前是否处于已发出 step.started、尚未发出 step.completed 的步骤中。 */
  #inStep = false
  #disposed = false

  constructor(init: RuntimeSessionInit, script: FakeScript, now: () => number) {
    this.#init = init
    this.#script = script
    this.#now = now
    this.#history = [...init.history]
  }

  onEvent(listener: (event: RuntimeEvent) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  exportHistory(): CanonicalMessage[] {
    return [...this.#history]
  }

  async steer(input: UserMessage): Promise<void> {
    this.#history.push(input)
  }

  async abort(): Promise<void> {
    this.#running?.abort()
  }

  async dispose(): Promise<void> {
    await this.abort()
    this.#disposed = true
    this.#listeners.clear()
  }

  async prompt(input: UserMessage): Promise<void> {
    this.#checkIdle()
    this.#history.push(input)
    const turn: FakeTurn = this.#script.turns[this.#turnIndex] ?? {
      steps: [{ kind: 'reply', text: textOf(input.content) }],
    }
    this.#turnIndex += 1
    await this.#runTurn(turn, 0)
  }

  async retry(): Promise<void> {
    this.#checkIdle()
    const resume = this.#resume
    if (!resume) throw new Error('FakeRuntime 会话没有可重试的失败')
    await this.#runTurn(resume.turn, resume.next)
  }

  #checkIdle(): void {
    if (this.#disposed) throw new Error('FakeRuntime 会话已释放')
    if (this.#running) throw new Error('FakeRuntime 会话正在运行')
  }

  /** 从第 `from` 步运行本轮（`fail` 是最后一步时从它重新开始）。 */
  async #runTurn(turn: FakeTurn, from: number): Promise<void> {
    const turnSignal = new TurnSignal()
    this.#running = turnSignal
    this.#resume = undefined
    const sessionSignal = this.#init.signal
    const onSignal = () => turnSignal.abort()
    sessionSignal.addEventListener('abort', onSignal, { once: true })
    if (sessionSignal.aborted) turnSignal.abort()
    try {
      for (let i = Math.min(from, turn.steps.length - 1); i < turn.steps.length; i++) {
        const step = turn.steps[i]!
        const done = await this.#runStep(step, turnSignal)
        if (done) {
          if (step.kind === 'fail') this.#resume = { turn, next: i + 1 }
          return
        }
      }
    } catch (e) {
      if (!(e instanceof Aborted)) throw e
      if (this.#inStep) this.#emit({ type: 'step.completed', finishReason: 'aborted' })
      this.#emit({ type: 'loop.ended', outcome: 'aborted' })
    } finally {
      this.#inStep = false
      sessionSignal.removeEventListener('abort', onSignal)
      this.#running = undefined
    }
  }

  /** 返回 true 表示本轮已结束。 */
  async #runStep(step: FakeStep, signal: AbortSignalLike): Promise<boolean> {
    const model = this.#init.model.ref
    this.#checkAborted()
    this.#emit({ type: 'step.started', model })
    this.#inStep = true
    // 监听者可能在 step.started 时就中止（例如达到限额）
    this.#checkAborted()

    if (step.kind === 'fail') {
      this.#inStep = false
      this.#emit({ type: 'step.completed', finishReason: 'error' })
      this.#emit({
        type: 'loop.ended',
        outcome: 'failed',
        error: step.error,
        retryable: step.retryable,
      })
      return true
    }

    const reasoning = step.reasoning ?? ''
    const text = step.text ?? ''
    for (const piece of chunks(reasoning, this.#script.chunkSize ?? 1)) {
      await this.#delay()
      this.#emit({ type: 'reasoning.delta', text: piece })
    }
    for (const piece of chunks(text, this.#script.chunkSize ?? 1)) {
      await this.#delay()
      this.#emit({ type: 'text.delta', text: piece })
    }

    const requested: readonly FakeToolCall[] =
      step.kind === 'tool' ? [step] : step.kind === 'tools' ? step.calls : []
    const calls: RuntimeToolCall[] = requested.map((c) => ({
      id: `fake-call-${++this.#callCounter}`,
      name: c.name,
      input: c.input,
    }))
    const message: AssistantMessage = {
      role: 'assistant',
      content: text === '' ? [] : [{ type: 'text', text }],
      ...(reasoning === '' ? {} : { reasoning: { text: reasoning, providerId: model.providerId } }),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      model,
      ts: this.#now(),
    }
    this.#history.push(message)
    this.#inStep = false
    this.#emit({ type: 'message.completed', message })
    this.#emit({
      type: 'step.completed',
      finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
      ...(step.usage ? { usage: step.usage } : {}),
    })

    if (calls.length === 0) {
      this.#emit({ type: 'loop.ended', outcome: 'completed' })
      return true
    }

    const parallel = calls.every(
      (c) => this.#init.tools.find((t) => t.name === c.name)?.parallel === true,
    )
    const results: RuntimeToolResult[] = []
    if (parallel) {
      results.push(
        ...(await Promise.all(calls.map((c, i) => this.#runTool(c, requested[i]!, signal)))),
      )
    } else {
      for (const [i, call] of calls.entries()) {
        results.push(await this.#runTool(call, requested[i]!, signal))
      }
    }
    calls.forEach((call, i) => {
      const result = results[i]!
      this.#history.push({
        role: 'tool',
        toolCallId: call.id,
        content: [...result.content],
        status: result.status,
        ts: this.#now(),
      })
    })
    return false
  }

  async #runTool(
    call: RuntimeToolCall,
    script: FakeToolCall,
    signal: AbortSignalLike,
  ): Promise<RuntimeToolResult> {
    if (script.rejectedWith !== undefined) {
      const code = script.rejectedWith
      this.#init.hooks.toolCallRejected?.(call, { code, params: { name: call.name } })
      return { status: 'error', content: [{ type: 'text', text: `Tool call rejected: ${code}` }] }
    }
    const gate = await this.#init.hooks.beforeToolCall(call)
    if (gate.action === 'deny') {
      return { status: 'denied', content: [{ type: 'text', text: gate.reason }] }
    }
    return this.#init.hooks.executeTool(call, signal)
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  #checkAborted(): void {
    if (this.#running?.aborted) throw new Aborted()
  }

  async #delay(): Promise<void> {
    this.#checkAborted()
    const ms = this.#script.delayMs ?? 0
    if (ms > 0) {
      const signal = this.#running!
      await new Promise<void>((resolve) => {
        const wake = () => {
          timers.clearTimeout(handle)
          signal.removeEventListener('abort', wake)
          resolve()
        }
        const handle = timers.setTimeout(wake, ms)
        signal.addEventListener('abort', wake)
      })
      this.#checkAborted()
    }
  }
}
