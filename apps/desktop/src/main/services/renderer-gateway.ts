/**
 * IPC 网关（M0-13b，ADR-0009，架构 §7.3、§15.2、§22）：主进程面向界面的 `MainForRenderer` 端点。
 *
 * - **请求校验**：参数与结果都由 `createEndpoint` 按协议校验；会话命令交给注入的 `SessionCommands`
 *   （会话管理器，M0-13c/d），设置交给 `SettingsCommands`（设置服务，M0-15d），凭据交给
 *   `CredentialCommands`（凭据存储，M1-03b；没有读出明文的接口），改动记录交给 `ChangeCommands`
 *   （改动服务，M1-08b），审批交给 `ApprovalCommands`（审批服务，M1-11b）。IPC 发送方的校验见 `renderer-transport.ts`。
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
  type McpStatusEvent,
  RendererForMain,
  type EventEnvelope,
  type RpcChannel,
  type RpcError,
} from '@cairn/protocol'
import type { z } from 'zod'
import type { CredentialCommands } from './credential-store.js'
import type { SessionEventService } from './event-service.js'
import type { ProjectCommands } from './project-service.js'
import type { SkillCommands } from './skill-service.js'
import type { McpCommands } from './mcp-service.js'
import type { AgentCommands } from './agent-service.js'
import type { DiagnosticsCommands } from './diagnostics-service.js'
import type { TrialCommands } from './trial-service.js'

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
  readonly rename: Handler<'session.rename'>
  readonly archive: Handler<'session.archive'>
  readonly setModel: Handler<'session.setModel'>
  readonly setAgent: Handler<'session.setAgent'>
  readonly compact: Handler<'session.compact'>
  readonly updateBrief: Handler<'session.brief.update'>
  readonly approvePlan: Handler<'plan.approve'>
  readonly replan: Handler<'plan.replan'>
  readonly abandonPlan: Handler<'plan.abandon'>
}

/** 由改动服务实现的改动命令（M1-08b）。 */
export interface ChangeCommands {
  readonly list: Handler<'changes.list'>
  readonly revert: Handler<'changes.revert'>
  readonly revertHunk: Handler<'changes.revertHunk'>
  readonly content: Handler<'changes.content'>
}

/** 由检查点服务实现的检查点命令（M1-12c）。 */
export interface CheckpointCommands {
  readonly list: Handler<'checkpoint.list'>
  readonly preview: Handler<'checkpoint.preview'>
  readonly restore: Handler<'checkpoint.restore'>
}

/** 由改动集服务实现的审阅与合并命令（M4-09）。 */
export interface ChangeSetCommands {
  readonly list: Handler<'changeset.list'>
  readonly get: Handler<'changeset.get'>
  readonly apply: Handler<'changeset.apply'>
  readonly reject: Handler<'changeset.reject'>
  readonly resolveConflict: Handler<'changeset.resolveConflict'>
}

/** 由审批服务实现的审批命令（M1-11b）。 */
export interface ApprovalCommands {
  readonly pending: Handler<'approval.pending'>
  readonly resolve: Handler<'approval.resolve'>
  /** 未决审批有变化时调用（推送 `approval.changed`）；返回取消函数。 */
  readonly subscribe: (listener: (sessionId: string) => void) => () => void
}

/** 运行检查器（M4-04）。 */
export interface InspectCommands {
  readonly inspect: Handler<'run.inspect'>
}

/** 活动中心（M4-06）：跨会话快照与就地审批。 */
export interface ActivityCommands {
  readonly list: Handler<'activity.list'>
  readonly resolve: Handler<'activity.resolve'>
  readonly subscribe: (listener: () => void) => () => void
}

/** 由供应商服务实现的连接测试与模型列表（M2-10）。 */
export interface ProviderCommands {
  readonly test: Handler<'provider.test'>
  readonly models: Handler<'provider.models'>
}

/** 由权限服务实现的规则管理（M2-11）。增删之后由调用方通知运行中的宿主。 */
export interface PermissionCommands {
  readonly list: Handler<'permissions.list'>
  readonly add: Handler<'permissions.add'>
  readonly delete: Handler<'permissions.delete'>
}

/** 由设置服务实现的设置命令。 */
export interface SettingsCommands {
  readonly get: () => z.input<Requests['settings.get']['result']>
  readonly update: (
    patch: z.output<Requests['settings.update']['params']>,
  ) => z.input<Requests['settings.update']['result']>
  /** 可选的 shell（M2-09）。 */
  readonly shell: Handler<'settings.shell'>
}

export const DEFAULT_FRAME_MS = 33

export interface RendererGatewayOptions {
  readonly events: Pick<SessionEventService, 'readAfter' | 'subscribe'>
  readonly commands: SessionCommands
  /** 项目（M1-16a）：列表与用系统对话框打开。 */
  readonly projects: ProjectCommands
  readonly settings: SettingsCommands
  /** 凭据命令（M1-03b）：界面只能写入、删除与查询是否已配置。 */
  readonly credentials: CredentialCommands
  /** 供应商（M2-10）：测试连接与拉取模型列表。 */
  readonly providers: ProviderCommands
  /** 权限规则（M2-11）：列出、手动添加与删除。 */
  readonly permissions: PermissionCommands
  /** 改动记录（M1-08b）：列出与整文件撤销。 */
  readonly changes: ChangeCommands
  /** 检查点（M1-12c）：列出、预览与恢复。 */
  readonly checkpoints: CheckpointCommands
  /** 改动集（M4-09）：列出、读取、合并、拒绝与冲突处理。 */
  readonly changeSets: ChangeSetCommands
  /** 审批（M1-11b）：读取未决审批与作出决定。 */
  readonly approvals: ApprovalCommands
  /** 技能（M3-07）：列表、安装、卸载与启用；选择来源（M3-08）。 */
  readonly skills: SkillCommands
  /** MCP 服务（M3-09）：配置、连接、工具与日志。 */
  readonly mcp: McpCommands
  /** Agent 定义（M3-11）：草稿、发布、版本、导入导出与生效配置。 */
  readonly agents: AgentCommands
  /** Agent 试运行（M4-12）。 */
  readonly trials: TrialCommands
  /** 诊断包（M3-13）：导出前清单、生成 zip 与在文件夹中显示。 */
  readonly diagnostics: DiagnosticsCommands
  /** 运行检查器（M4-04）：运行树、上下文快照与生效设置。 */
  readonly inspect: InspectCommands
  /** 活动中心（M4-06）：跨会话快照与就地审批。 */
  readonly activity: ActivityCommands
  /** MCP 状态变化的订阅（M3-09）。 */
  readonly mcpStatus: (listener: (event: z.output<typeof McpStatusEvent>) => void) => () => void
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
  /** 点击系统通知后让所有窗口打开对应会话（M4-06）。 */
  openActivitySession(sessionId: string): void
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
  const { events, commands, projects, settings, credentials, providers } = options
  const { changes, checkpoints, approvals, permissions, skills, mcp } = options
  const { agents, trials, diagnostics, activity, changeSets } = options
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS
  const connections = new Set<{
    deliver: (sessionId: string, events: readonly EventEnvelope[]) => void
    approvalsChanged: (sessionId: string) => void
    activityChanged: () => void
    openActivitySession: (sessionId: string) => void
    mcpStatus: (event: z.output<typeof McpStatusEvent>) => void
    close: () => void
  }>()

  const unsubscribeEvents = events.subscribe((sessionId, batch) => {
    for (const connection of connections) connection.deliver(sessionId, batch)
  })
  const unsubscribeApprovals = approvals.subscribe((sessionId) => {
    for (const connection of connections) connection.approvalsChanged(sessionId)
  })
  const unsubscribeActivity = activity.subscribe(() => {
    for (const connection of connections) connection.activityChanged()
  })
  const unsubscribeMcp = options.mcpStatus((event) => {
    for (const connection of connections) connection.mcpStatus(event)
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
      endpoint.handle('project.list', () => projects.list())
      endpoint.handle('project.open', () => projects.open())
      endpoint.handle('project.update', (params) => projects.update(params))
      endpoint.handle('project.remove', (params) => projects.remove(params))
      endpoint.handle('session.prompt', (params) => commands.prompt(params))
      endpoint.handle('plan.approve', (params) => commands.approvePlan(params))
      endpoint.handle('plan.replan', (params) => commands.replan(params))
      endpoint.handle('plan.abandon', (params) => commands.abandonPlan(params))
      endpoint.handle('session.compact', (params) => commands.compact(params))
      endpoint.handle('session.brief.update', (params) => commands.updateBrief(params))
      endpoint.handle('session.abort', (params) => commands.abort(params))
      endpoint.handle('session.rename', (params) => commands.rename(params))
      endpoint.handle('session.archive', (params) => commands.archive(params))
      endpoint.handle('session.setModel', (params) => commands.setModel(params))
      endpoint.handle('session.setAgent', (params) => commands.setAgent(params))
      endpoint.handle('settings.get', () => settings.get())
      endpoint.handle('settings.update', (patch) => settings.update(patch))
      endpoint.handle('settings.shell', (params) => settings.shell(params))
      endpoint.handle('credentials.set', (params) => credentials.set(params))
      endpoint.handle('credentials.delete', (params) => credentials.delete(params))
      endpoint.handle('credentials.status', (params) => credentials.status(params))
      endpoint.handle('provider.test', (params) => providers.test(params))
      endpoint.handle('provider.models', (params) => providers.models(params))
      endpoint.handle('permissions.list', (params) => permissions.list(params))
      endpoint.handle('permissions.add', (params) => permissions.add(params))
      endpoint.handle('permissions.delete', (params) => permissions.delete(params))
      endpoint.handle('changes.list', (params) => changes.list(params))
      endpoint.handle('changes.revert', (params) => changes.revert(params))
      endpoint.handle('changes.revertHunk', (params) => changes.revertHunk(params))
      endpoint.handle('changes.content', (params) => changes.content(params))
      endpoint.handle('checkpoint.list', (params) => checkpoints.list(params))
      endpoint.handle('checkpoint.preview', (params) => checkpoints.preview(params))
      endpoint.handle('checkpoint.restore', (params) => checkpoints.restore(params))
      endpoint.handle('changeset.list', (params) => changeSets.list(params))
      endpoint.handle('changeset.get', (params) => changeSets.get(params))
      endpoint.handle('changeset.apply', (params) => changeSets.apply(params))
      endpoint.handle('changeset.reject', (params) => changeSets.reject(params))
      endpoint.handle('changeset.resolveConflict', (params) => changeSets.resolveConflict(params))
      endpoint.handle('approval.pending', (params) => approvals.pending(params))
      endpoint.handle('approval.resolve', (params) => approvals.resolve(params))
      endpoint.handle('activity.list', (params) => activity.list(params))
      endpoint.handle('activity.resolve', (params) => activity.resolve(params))
      endpoint.handle('skill.list', (params) => skills.list(params))
      endpoint.handle('skill.get', (params) => skills.get(params))
      endpoint.handle('skill.pickSource', (params) => skills.pickSource(params))
      endpoint.handle('skill.install', (params) => skills.install(params))
      endpoint.handle('skill.uninstall', (params) => skills.uninstall(params))
      endpoint.handle('skill.setEnabled', (params) => skills.setEnabled(params))
      endpoint.handle('mcp.list', (params) => mcp.list(params))
      endpoint.handle('mcp.get', (params) => mcp.get(params))
      endpoint.handle('mcp.add', (params) => mcp.add(params))
      endpoint.handle('mcp.update', (params) => mcp.update(params))
      endpoint.handle('mcp.remove', (params) => mcp.remove(params))
      endpoint.handle('mcp.reconnect', (params) => mcp.reconnect(params))
      endpoint.handle('mcp.setEnabled', (params) => mcp.setEnabled(params))
      endpoint.handle('mcp.tools', (params) => mcp.tools(params))
      endpoint.handle('mcp.setTool', (params) => mcp.setTool(params))
      endpoint.handle('mcp.logs', (params) => mcp.logs(params))
      endpoint.handle('agent.list', (params) => agents.list(params))
      endpoint.handle('agent.get', (params) => agents.get(params))
      endpoint.handle('agent.saveDraft', (params) => agents.saveDraft(params))
      endpoint.handle('agent.publish', (params) => agents.publish(params))
      endpoint.handle('agent.duplicate', (params) => agents.duplicate(params))
      endpoint.handle('agent.archive', (params) => agents.archive(params))
      endpoint.handle('agent.unarchive', (params) => agents.unarchive(params))
      endpoint.handle('agent.delete', (params) => agents.delete(params))
      endpoint.handle('agent.versions', (params) => agents.versions(params))
      endpoint.handle('agent.diff', (params) => agents.diff(params))
      endpoint.handle('agent.export', (params) => agents.export(params))
      endpoint.handle('agent.import', (params) => agents.import(params))
      endpoint.handle('agent.effectiveConfig', (params) => agents.effectiveConfig(params))
      endpoint.handle('trial.start', (params) => trials.start(params))
      endpoint.handle('trial.restart', (params) => trials.restart(params))
      endpoint.handle('trial.clear', (params) => trials.clear(params))
      endpoint.handle('trial.list', (params) => trials.list(params))
      endpoint.handle('diagnostics.summary', (params) => diagnostics.summary(params))
      endpoint.handle('diagnostics.export', (params) => diagnostics.export(params))
      endpoint.handle('diagnostics.showInFolder', (params) => diagnostics.showInFolder(params))

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

      endpoint.handle('run.inspect', (params) => options.inspect.inspect(params))

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
        approvalsChanged(sessionId: string) {
          // 先推送已排队的事件，界面看到的状态与审批一致
          if (!subs.has(sessionId)) return
          flush()
          endpoint.emit('approval.changed', { sessionId })
        },
        activityChanged() {
          if (closed) return
          endpoint.emit('activity.changed', {})
        },
        openActivitySession(sessionId: string) {
          if (closed) return
          endpoint.emit('activity.open', { sessionId })
        },
        mcpStatus(event: z.output<typeof McpStatusEvent>) {
          if (closed) return
          endpoint.emit('mcp.status', event)
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

    openActivitySession(sessionId) {
      for (const connection of connections) connection.openActivitySession(sessionId)
    },

    close() {
      unsubscribeEvents()
      unsubscribeApprovals()
      unsubscribeActivity()
      unsubscribeMcp()
      for (const connection of [...connections]) connection.close()
    },
  }
}
