/**
 * 渲染进程 ↔ 主进程的接口（架构 §15.2）。
 * 渲染进程只调用主进程的请求、接收主进程的事件；渲染进程自身不提供接口。
 */
import { z } from 'zod'
import { ContentPart, Id, Timestamp } from '../common.js'
import { EventEnvelopeSchema } from '../events.js'
import { defineSide } from '../rpc.js'

/** 会话在列表中显示的状态（由运行状态汇总得出）。 */
export const SessionStatus = z.enum([
  'idle',
  'running',
  'waiting_approval',
  'failed',
  'interrupted',
  'crashed',
  'archived',
])
export type SessionStatus = z.infer<typeof SessionStatus>

export const SessionSummary = z.object({
  sessionId: Id,
  title: z.string(),
  projectPath: z.string(),
  status: SessionStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type SessionSummary = z.infer<typeof SessionSummary>

/** seq 从 1 开始；afterSeq 为 0 表示从头读取。 */
const Seq = z.number().int().nonnegative()

export const MainForRenderer = defineSide({
  requests: {
    'session.create': {
      params: z.object({ projectPath: z.string().min(1), title: z.string().optional() }),
      result: z.object({ sessionId: Id }),
    },
    'session.list': {
      params: z.object({ includeArchived: z.boolean().optional() }),
      result: z.object({ sessions: z.array(SessionSummary) }),
    },
    'session.prompt': {
      params: z.object({ sessionId: Id, content: z.array(ContentPart).min(1) }),
      result: z.object({ messageId: Id }),
    },
    'session.abort': {
      params: z.object({ sessionId: Id }),
      result: z.object({}),
    },
    /**
     * 订阅会话事件：先返回 afterSeq 之后的持久化事件（补发），
     * 之后的事件通过 session.events 推送，二者之间无重复、无遗漏（架构 §7.3）。
     */
    'session.subscribe': {
      params: z.object({ sessionId: Id, afterSeq: Seq }),
      result: z.object({ events: z.array(EventEnvelopeSchema), lastSeq: Seq }),
    },
    'session.unsubscribe': {
      params: z.object({ sessionId: Id }),
      result: z.object({}),
    },
  },
  events: {
    /** 实时事件推送；增量事件在主进程合并后按帧率批量推送（架构 §22）。 */
    'session.events': z.object({ sessionId: Id, events: z.array(EventEnvelopeSchema) }),
  },
})

export const RendererForMain = defineSide({ requests: {}, events: {} })

/**
 * 已规划、尚未实现的接口名（架构 §15.2）。实现时从这里移入 MainForRenderer。
 */
export const RESERVED_RENDERER_MAIN_METHODS = [
  'project.open',
  'project.list',
  'session.rename',
  'session.archive',
  'approval.resolve',
  'changes.list',
  'changes.revert',
  'checkpoint.list',
  'checkpoint.restore',
  'settings.get',
  'settings.update',
  'credentials.set',
  'credentials.delete',
  'credentials.status',
  'provider.test',
] as const
