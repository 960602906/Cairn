/**
 * 宿主进程生命周期（M0-13c，ADR-0003，架构 §4、§21）。
 *
 * `startHost(init)`：启动宿主进程 → 协议握手 → `host.init`。成功后：
 * - 宿主发出的 `host.event` 交给存储服务分配 seq、落库、转发；其他会话的事件丢弃；
 * - 定期请求 `host.heartbeat`，超时视为卡死；
 * - 宿主意外退出或卡死时结束进程，写入 `session.crashed`（错误码 `host.exited` / `host.unresponsive`）。
 *
 * `host.init` 前按模型解析凭据（M1-03b，ADR-0010）与模型配置（M1-04b），只经 `host.init` 传给宿主；
 * 无法解析（系统加密不可用、无法解密、模型已从配置中删除）按启动失败处理，原因的错误码记入 `cause`。
 * 适用于会话的权限规则（M1-10c）同样在 `host.init` 前汇总并下发。
 *
 * 宿主的 `host.approval.request` 与 `host.approval.cancelled`（M1-11a）交给审批服务（M1-11b），会话与运行
 * 同样按这个宿主填入。
 *
 * 宿主的 `changes.record`（M1-08b）交给改动服务，会话与运行按这个宿主填入，宿主不能写入其他会话的记录。
 *
 * 启动失败（进程无法创建、握手或初始化超时、协议不兼容）同样写入 `session.crashed`
 * （`host.start_failed`），并以 `RpcError` 拒绝。`stop()` 请求宿主正常退出，超时后强制结束，
 * 不写崩溃事件。
 *
 * 并发上限、空闲回收与退出清理由会话管理器（M0-13d）负责。
 */
import {
  createEndpoint,
  HostForMain,
  type FileChangeInput,
  type HostApprovalRequest,
  type HostApprovalResponse,
  MainForHost,
  RpcError,
  type ErrorInfo,
  type HostModelConfig,
  type PermissionRule,
  type RequestOptions,
  type RpcEndpoint,
} from '@nexus/protocol'
import type { ResolvedCredential } from '@nexus/core'
import type { z } from 'zod'
import type { SessionEventService } from './event-service.js'
import type { HostProcess, SpawnHost } from './host-process.js'

export const HostErrorCode = {
  /** 宿主无法启动：进程创建失败、握手或初始化失败。 */
  StartFailed: 'host.start_failed',
  /** 宿主进程意外退出。 */
  Exited: 'host.exited',
  /** 心跳超时，宿主视为卡死并被结束。 */
  Unresponsive: 'host.unresponsive',
} as const

/** 会话管理器给出的初始化参数；凭据、模型配置与权限规则由监督器解析后加入。 */
export type HostInit = Omit<
  z.input<(typeof HostForMain)['requests']['host.init']['params']>,
  'credential' | 'modelConfig' | 'permissionRules'
>

export type HostState = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

export interface HostExit {
  readonly reason: 'stopped' | 'crashed'
  readonly error?: ErrorInfo
}

export interface HostHandle {
  readonly sessionId: string
  readonly runId: string
  readonly pid: number | undefined
  state(): HostState
  /** 转发用户输入（`message.user` 已由主进程落库）。 */
  prompt(params: z.input<(typeof HostForMain)['requests']['host.prompt']['params']>): Promise<void>
  abort(reason: 'user' | 'shutdown'): Promise<void>
  /** 请求宿主正常退出；超时后强制结束。重复调用返回同一个 Promise。 */
  stop(): Promise<HostExit>
  /** 宿主结束（正常停止或崩溃）时 resolve。 */
  readonly exited: Promise<HostExit>
}

export interface HostSupervisorOptions {
  readonly spawn: SpawnHost
  readonly events: Pick<SessionEventService, 'publish'>
  /** 按模型解析凭据（M1-03b）；没有保存凭据时返回 undefined。省略表示不传凭据。 */
  readonly resolveCredential?: (model: HostInit['model']) => Promise<ResolvedCredential | undefined>
  /**
   * 按模型给出宿主的模型配置（M1-04b）；没有时返回 undefined（宿主用 FakeRuntime 或开发用的
   * 环境变量）。抛出时按启动失败处理。省略表示不传。
   */
  readonly resolveModelConfig?: (model: HostInit['model']) => HostModelConfig | undefined
  /**
   * 适用于会话的权限规则（M1-10c，权限服务）。抛出时按启动失败处理。省略时不传，宿主按“询问”模式
   * 的预设判定。
   */
  readonly resolvePermissionRules?: (sessionId: string) => PermissionRule[]
  /**
   * 记录宿主报告的文件改动（M1-08b，改动服务）。会话与运行由这个宿主确定。
   * 省略时宿主的 `changes.record` 报 `run.unsupported`。
   */
  readonly recordChange?: (
    sessionId: string,
    runId: string,
    input: FileChangeInput,
  ) => Promise<{ changeId: string }>
  /**
   * 转交宿主的审批请求（M1-11a，审批服务），等用户决定后返回。省略时报 `run.unsupported`，
   * 宿主按工具执行失败处理。
   */
  readonly requestApproval?: (
    sessionId: string,
    runId: string,
    request: HostApprovalRequest,
  ) => Promise<HostApprovalResponse>
  /** 宿主取消了未决审批（M1-11a）。 */
  readonly cancelApproval?: (sessionId: string, approvalId: string) => void
  /** 握手与 `host.init` 的总时限，默认 10 秒。 */
  readonly startTimeoutMs?: number
  /** 心跳间隔，默认 5 秒。 */
  readonly heartbeatIntervalMs?: number
  /** 单次心跳的超时，默认 10 秒。 */
  readonly heartbeatTimeoutMs?: number
  /** `stop()` 等待宿主自行退出的时间，默认 3 秒。 */
  readonly shutdownTimeoutMs?: number
  readonly now?: () => number
  /** 记录异常：写崩溃事件失败、宿主发来其他会话的事件等。 */
  readonly onError?: (error: unknown) => void
}

export interface HostSupervisor {
  startHost(init: HostInit): Promise<HostHandle>
}

type Timer = ReturnType<typeof setTimeout>

export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000
  const now = options.now ?? Date.now

  return {
    async startHost(init) {
      const { sessionId, runId } = init

      const recordCrash = (error: ErrorInfo) => {
        try {
          options.events.publish([
            { v: 1, sessionId, runId, ts: now(), type: 'session.crashed', payload: { error } },
          ])
        } catch (e) {
          options.onError?.(e)
        }
      }

      let proc: HostProcess
      try {
        proc = options.spawn(sessionId)
      } catch (cause) {
        options.onError?.(cause)
        const error = { code: HostErrorCode.StartFailed }
        recordCrash(error)
        throw new RpcError(error.code)
      }

      let state: HostState = 'starting'
      let heartbeat: Timer | undefined
      let stopping: Promise<HostExit> | undefined
      let resolveExited!: (exit: HostExit) => void
      const exited = new Promise<HostExit>((resolve) => (resolveExited = resolve))

      const endpoint: RpcEndpoint<typeof MainForHost, typeof HostForMain> = createEndpoint(
        proc.channel,
        { local: MainForHost, remote: HostForMain },
      )

      const finish = (exit: HostExit) => {
        if (state === 'stopped' || state === 'crashed') return
        state = exit.reason
        if (heartbeat !== undefined) clearTimeout(heartbeat)
        endpoint.close()
        proc.kill()
        if (exit.error) recordCrash(exit.error)
        resolveExited(exit)
      }
      const crash = (code: string, params?: ErrorInfo['params']) =>
        finish({ reason: 'crashed', error: params ? { code, params } : { code } })

      proc.onExit((exitCode) => {
        if (state === 'stopping') finish({ reason: 'stopped' })
        else
          crash(state === 'starting' ? HostErrorCode.StartFailed : HostErrorCode.Exited, {
            exitCode,
          })
      })

      endpoint.handle('changes.record', (input) => {
        if (!options.recordChange) throw new RpcError('run.unsupported')
        return options.recordChange(sessionId, runId, input)
      })

      endpoint.handle('host.approval.request', (request) => {
        if (!options.requestApproval) throw new RpcError('run.unsupported')
        return options.requestApproval(sessionId, runId, request)
      })
      endpoint.on('host.approval.cancelled', ({ approvalId }) =>
        options.cancelApproval?.(sessionId, approvalId),
      )

      endpoint.on('host.event', ({ event }) => {
        if (state !== 'running' && state !== 'starting') return
        if (event.sessionId !== sessionId) {
          options.onError?.(
            new RpcError('rpc.invalid_params', { expected: sessionId, actual: event.sessionId }),
          )
          return
        }
        try {
          options.events.publish([event])
        } catch (e) {
          options.onError?.(e)
        }
      })

      const scheduleHeartbeat = () => {
        heartbeat = setTimeout(() => {
          heartbeat = undefined
          endpoint.request('host.heartbeat', {}, { timeoutMs: heartbeatTimeoutMs }).then(
            () => {
              if (state === 'running') scheduleHeartbeat()
            },
            () => {
              if (state === 'running') crash(HostErrorCode.Unresponsive)
            },
          )
        }, heartbeatIntervalMs)
      }

      // 握手与初始化在总时限内完成
      const started = (async () => {
        await endpoint.ready
        const modelConfig = options.resolveModelConfig?.(init.model)
        const permissionRules = options.resolvePermissionRules?.(sessionId)
        const credential = await options.resolveCredential?.(init.model)
        await endpoint.request(
          'host.init',
          {
            ...init,
            ...(credential ? { credential: { apiKey: credential.apiKey } } : {}),
            ...(modelConfig ? { modelConfig } : {}),
            ...(permissionRules ? { permissionRules } : {}),
          },
          { timeoutMs: startTimeoutMs },
        )
      })()
      let startTimer: Timer | undefined
      const timedOut = new Promise<never>((_, reject) => {
        startTimer = setTimeout(
          () => reject(new RpcError('rpc.timeout', { timeoutMs: startTimeoutMs })),
          startTimeoutMs,
        )
      })
      const exitedEarly = exited.then(() => {
        throw new RpcError(HostErrorCode.Exited)
      })
      exitedEarly.catch(() => undefined)
      timedOut.catch(() => undefined)
      try {
        await Promise.race([started, timedOut, exitedEarly])
      } catch (cause) {
        options.onError?.(cause)
        const params: ErrorInfo['params'] =
          cause instanceof RpcError ? { cause: cause.code } : undefined
        if (state === 'starting') crash(HostErrorCode.StartFailed, params)
        started.catch(() => undefined)
        throw new RpcError(HostErrorCode.StartFailed)
      } finally {
        clearTimeout(startTimer)
      }

      state = 'running'
      scheduleHeartbeat()

      const call = async (
        method: 'host.prompt' | 'host.abort',
        params: object,
        o?: RequestOptions,
      ) => {
        await endpoint.request(method, params as never, o)
      }

      return {
        sessionId,
        runId,
        pid: proc.pid,
        state: () => state,
        prompt: (params) => call('host.prompt', params),
        abort: (reason) => call('host.abort', { reason }),
        exited,
        stop() {
          if (stopping) return stopping
          if (state !== 'running') return (stopping = exited)
          state = 'stopping'
          if (heartbeat !== undefined) clearTimeout(heartbeat)
          const force = setTimeout(() => finish({ reason: 'stopped' }), shutdownTimeoutMs)
          endpoint
            .request('host.shutdown', {}, { timeoutMs: shutdownTimeoutMs })
            .catch(() => finish({ reason: 'stopped' }))
          stopping = exited.finally(() => clearTimeout(force))
          return stopping
        },
      }
    },
  }
}
