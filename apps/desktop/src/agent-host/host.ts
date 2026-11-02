/**
 * agent 宿主（M0-14，ADR-0003、ADR-0004，架构 §8.4，Runtime §13）：主进程 `HostForMain` 接口的实现。
 *
 * - `host.init`：用注入的运行时创建 `RunSupervisor` 与运行；带 `resume` 时恢复已有运行（以历史
 *   重建运行时会话，不发出 `run.created`；记录的运行中状态按中断处理）。
 * - `host.prompt`：交给运行排队执行，立即返回；一轮的结果以事件回传。
 * - `host.abort`：中止当前轮次（发出 `turn.aborted`）。
 * - `host.shutdown`：中止进行中的轮次（`turn.aborted`，原因 `shutdown`），回复后退出进程。
 *   运行不释放：下次启动宿主时由主进程以 `resume` 继续同一个运行。
 * - `host.heartbeat`：回复当前时间。
 * 运行发出的事件以 `host.event` 原样转发，seq 由主进程分配。
 *
 * 运行时与模型解析由入口注入，M1 换成 pi 适配器时这里不改。不依赖 Electron。
 */
import {
  createRunSupervisor,
  type AgentRunHandle,
  type AgentRuntime,
  type ResolvedModel,
  type RunSupervisor,
} from '@nexus/core'
import {
  createEndpoint,
  HostForMain,
  MainForHost,
  RpcError,
  type ModelRef,
  type RpcChannel,
  type RpcEndpoint,
} from '@nexus/protocol'

export const AgentHostErrorCode = {
  /** 尚未收到 `host.init`，或重复初始化。 */
  NotInitialized: 'host.not_initialized',
  AlreadyInitialized: 'host.already_initialized',
} as const

/** 一次初始化所用的运行时与模型。 */
export interface HostRuntime {
  readonly runtime: AgentRuntime
  readonly model: ResolvedModel
}

export interface AgentHostOptions {
  readonly channel: RpcChannel
  /** 按 `host.init` 的模型创建运行时（M0 为 FakeRuntime）。 */
  readonly createRuntime: (model: ModelRef) => HostRuntime | Promise<HostRuntime>
  /** 退出进程（`host.shutdown` 回复之后调用）。 */
  readonly exit: (code: number) => void
  /** 轮次、步骤、消息的 id；必须全局唯一（同一运行跨宿主重启也不能重复）。 */
  readonly createId: () => string
  readonly now?: () => number
  /** 记录异常（如排队的输入执行失败）。 */
  readonly onError?: (error: unknown) => void
}

export interface AgentHost {
  readonly endpoint: RpcEndpoint<typeof HostForMain, typeof MainForHost>
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const now = options.now ?? Date.now
  const onError = (error: unknown) => options.onError?.(error)
  const endpoint = createEndpoint(options.channel, { local: HostForMain, remote: MainForHost })
  const shutdown = new AbortController()
  let supervisor: RunSupervisor | undefined
  let run: AgentRunHandle | undefined
  let initializing = false

  const requireRun = () => {
    if (!run) throw new RpcError(AgentHostErrorCode.NotInitialized)
    return run
  }

  endpoint.handle('host.init', async (init) => {
    if (initializing || run) throw new RpcError(AgentHostErrorCode.AlreadyInitialized)
    initializing = true
    const { runtime, model } = await options.createRuntime(init.model)
    supervisor = createRunSupervisor({
      runtime,
      model,
      limits: init.limits,
      signal: shutdown.signal,
      createId: options.createId,
      now,
    })
    supervisor.onEvent((event) => endpoint.emit('host.event', { event }))
    run = await supervisor.createRun({
      sessionId: init.sessionId,
      runId: init.runId,
      agent: init.agent,
      workspace: { path: init.workspacePath },
      mode: init.mode,
      ...(init.resume
        ? { restoreFrom: { runId: init.runId, history: init.history, state: init.resume.state } }
        : {}),
    })
    return {}
  })

  endpoint.handle('host.prompt', (input) => {
    // 一轮结束才 resolve；结果以事件回传，这里不等待
    requireRun().send(input).catch(onError)
    return {}
  })

  endpoint.handle('host.abort', async ({ reason }) => {
    await requireRun().abort(reason)
    return {}
  })

  endpoint.handle('host.shutdown', async () => {
    await supervisor?.abortAll('shutdown')
    shutdown.abort()
    // 先让回复发出，再退出
    setTimeout(() => {
      endpoint.close()
      options.exit(0)
    }, 0)
    return {}
  })

  endpoint.handle('host.heartbeat', () => ({ ts: now() }))

  return { endpoint }
}
