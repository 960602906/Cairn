/**
 * IPC 网关（M0-13b，ADR-0009，架构 §7.3、§15.2、§22）：主进程面向界面的 `MainForRenderer` 端点。
 *
 * - **请求校验**：参数与结果都由 `createEndpoint` 按协议校验；会话命令交给注入的 `SessionCommands`
 *   （会话管理器，M0-13c/d），设置交给 `SettingsCommands`（设置服务，M0-15d），凭据交给
 *   `CredentialCommands`（凭据存储，M1-03b；没有读出明文的接口），改动记录交给 `ChangeCommands`
 *   （改动服务，M1-08b）。IPC 发送方的校验见 `renderer-transport.ts`。
 * - **补发与实时衔接**：`session.subscribe(afterSeq)` 同步读取数据库中 `afterSeq` 之后的持久化事件并
 *   记下游标；之后到达的事件只转发 seq 大于游标的部分。读取与登记之间没有异步间隙，因此无重复、
 *   无遗漏。订阅响应发出之前到达的实时事件先缓存，响应发出后再推送，保证界面先拿到补发的事件。
 * - **按帧推送**：持久化事件立即推送（连同之前缓存的增量）；增量事件缓存到下一帧（默认约 30 次/秒），
 *   相邻且属于同一消息的增量合并为一条。
 *
 * 不依赖 Electron：每个窗口用一个 `RpcChannel` 调用 `connect`。
 */
import {
  createEndpoint,
  isPersistedEvent,
  MainForRenderer,
  RendererForMain,
  type EventEnvelope,
  type RpcChannel,
  type RpcError,
} from '@nexus/protocol'
import type { z } from 'zod'
import type { CredentialCommands } from './credential-store.js'
import type { SessionEventService } from './event-service.js'

type Requests = (typeof MainForRenderer)['requests']
type Handler<M extends keyof Requests> = (
  params: z.output<Requests[M]['params']>,
) => z.input<Requests[M]['result']> | Promise<z.input<Requests[M]['result']>>

/** 由会话管理器实现的会话命令。 */
export interface SessionCommands {
  readonly create: Handler<'session.create'>
  readonly list: Handler<'session.list'>
  readonly prompt: Handler<'session.prompt'>
  readonly abort: Handler<'session.abort'>
}

/** 由改动服务实现的改动命令（M1-08b）。 */
export interface ChangeCommands {
  readonly list: Handler<'changes.list'>
  readonly revert: Handler<'changes.revert'>
}

/** 由设置服务实现的设置命令。 */
export interface SettingsCommands {
  readonly get: () => z.input<Requests['settings.get']['result']>
  readonly update: (
    patch: z.output<Requests['settings.update']['params']>,
  ) => z.input<Requests['settings.update']['result']>
}

export const DEFAULT_FRAME_MS = 33

export interface RendererGatewayOptions {
  readonly events: Pick<SessionEventService, 'readAfter' | 'subscribe'>
  readonly commands: SessionCommands
  readonly settings: SettingsCommands
  /** 凭据命令（M1-03b）：界面只能写入、删除与查询是否已配置。 */
  readonly credentials: CredentialCommands
  /** 改动记录（M1-08b）：列出与整文件撤销。 */
  readonly changes: ChangeCommands
  /** 增量事件的推送间隔，默认 33 ms（约 30 次/秒）。 */
  readonly frameMs?: number
  readonly onProtocolError?: (error: RpcError, message: unknown) => void
}

export interface RendererConnection {
  /** 与界面握手完成。 */
  readonly ready: Promise<void>
  /** 当前订阅的会话。 */
  subscriptions(): string[]
  /** 窗口关闭时调用：取消全部订阅并关闭端点。 */
  close(): void
}

export interface RendererGateway {
  connect(channel: RpcChannel): RendererConnection
  /** 关闭所有连接并停止接收事件。 */
  close(): void
}

/** 合并相邻、属于同一消息（或同一工具输出流）的增量事件，seq 与时间取最后一条。 */
export function coalesceDeltas(events: readonly EventEnvelope[]): EventEnvelope[] {
  const out: EventEnvelope[] = []
  for (const event of events) {
    const prev = out.at(-1)
    if (prev && canMerge(prev, event)) {
      out[out.length - 1] = {
        ...event,
        payload: { ...event.payload, text: prev.payload.text + (event as TextDelta).payload.text },
      } as EventEnvelope
    } else {
      out.push(event)
    }
  }
  return out
}

type TextDelta = EventEnvelope<
  'message.assistant.delta' | 'message.reasoning.delta' | 'tool.output.delta'
>

function canMerge(prev: EventEnvelope, next: EventEnvelope): prev is TextDelta {
  if (prev.type !== next.type || prev.runId !== next.runId) return false
  if (prev.type === 'message.assistant.delta' || prev.type === 'message.reasoning.delta') {
    return prev.payload.messageId === (next as typeof prev).payload.messageId
  }
  if (prev.type === 'tool.output.delta') {
    const n = next as typeof prev
    return (
      prev.payload.toolCallId === n.payload.toolCallId && prev.payload.stream === n.payload.stream
    )
  }
  return false
}

interface Subscription {
  /** 已发给界面（或已排队）的最大 seq。 */
  cursor: number
  /** 订阅响应发出前不推送。 */
  acked: boolean
  queue: EventEnvelope[]
}

type Timer = ReturnType<typeof setTimeout>

export function createRendererGateway(options: RendererGatewayOptions): RendererGateway {
  const { events, commands, settings, credentials, changes } = options
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS
  const connections = new Set<{
    deliver: (sessionId: string, events: readonly EventEnvelope[]) => void
    close: () => void
  }>()

  const unsubscribeEvents = events.subscribe((sessionId, batch) => {
    for (const connection of connections) connection.deliver(sessionId, batch)
  })

  return {
    connect(channel) {
      const endpoint = createEndpoint(channel, {
        local: MainForRenderer,
        remote: RendererForMain,
        ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
      })
      const subs = new Map<string, Subscription>()
      const timers = new Set<Timer>()
      let frame: Timer | undefined
      let closed = false

      const later = (fn: () => void, ms: number): Timer => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          fn()
        }, ms)
        timers.add(timer)
        return timer
      }

      const flush = () => {
        if (frame !== undefined) {
          clearTimeout(frame)
          timers.delete(frame)
          frame = undefined
        }
        for (const [sessionId, sub] of subs) {
          if (!sub.acked || sub.queue.length === 0) continue
          const batch = coalesceDeltas(sub.queue)
          sub.queue = []
          endpoint.emit('session.events', { sessionId, events: batch })
        }
      }

      const scheduleFrame = () => {
        if (frame === undefined) frame = later(flush, frameMs)
      }

      endpoint.handle('session.create', (params) => commands.create(params))
      endpoint.handle('session.list', (params) => commands.list(params))
      endpoint.handle('session.prompt', (params) => commands.prompt(params))
      endpoint.handle('session.abort', (params) => commands.abort(params))
      endpoint.handle('settings.get', () => settings.get())
      endpoint.handle('settings.update', (patch) => settings.update(patch))
      endpoint.handle('credentials.set', (params) => credentials.set(params))
      endpoint.handle('credentials.delete', (params) => credentials.delete(params))
      endpoint.handle('credentials.status', (params) => credentials.status(params))
      endpoint.handle('changes.list', (params) => changes.list(params))
      endpoint.handle('changes.revert', (params) => changes.revert(params))

      endpoint.handle('session.subscribe', ({ sessionId, afterSeq }) => {
        // 读取与登记在同一个同步步骤中完成，期间不会有新事件发布
        const backfill = events.readAfter(sessionId, afterSeq)
        const cursor = backfill.at(-1)?.seq ?? afterSeq
        const sub: Subscription = { cursor, acked: false, queue: [] }
        subs.set(sessionId, sub)
        // 响应在本轮微任务中发出；之后再放行缓存的实时事件
        later(() => {
          if (subs.get(sessionId) !== sub) return
          sub.acked = true
          flush()
        }, 0)
        return { events: backfill, lastSeq: cursor }
      })

      endpoint.handle('session.unsubscribe', ({ sessionId }) => {
        subs.delete(sessionId)
        return {}
      })

      const connection = {
        deliver(sessionId: string, batch: readonly EventEnvelope[]) {
          const sub = subs.get(sessionId)
          if (!sub) return
          let persisted = false
          for (const event of batch) {
            if (event.seq <= sub.cursor) continue
            sub.cursor = event.seq
            sub.queue.push(event)
            if (isPersistedEvent(event)) persisted = true
          }
          if (sub.queue.length === 0 || !sub.acked) return
          if (persisted) flush()
          else scheduleFrame()
        },
        close() {
          if (closed) return
          closed = true
          for (const timer of timers) clearTimeout(timer)
          timers.clear()
          subs.clear()
          endpoint.close()
          connections.delete(connection)
        },
      }
      connections.add(connection)

      return {
        ready: endpoint.ready,
        subscriptions: () => [...subs.keys()],
        close: connection.close,
      }
    },

    close() {
      unsubscribeEvents()
      for (const connection of [...connections]) connection.close()
    },
  }
}
