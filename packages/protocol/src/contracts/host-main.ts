/**
 * 主进程 ↔ Agent 宿主进程的接口（架构 §15.3，ADR-0003）。
 * 主进程控制宿主（请求），宿主把运行时事件推给主进程（事件，无 seq，由主进程分配）。
 */
import { z } from 'zod'
import {
  AgentDefinitionRef,
  CanonicalMessage,
  ContentPart,
  Id,
  ModelRef,
  RunLimits,
  RunMode,
  Timestamp,
} from '../common.js'
import { UnsequencedEventSchema } from '../events.js'
import { defineSide } from '../rpc.js'

export const HostForMain = defineSide({
  requests: {
    /** 会话配置与历史。模型凭据在 M1 加入（只经 MessagePort 传递，ADR-0010）。 */
    'host.init': {
      params: z.object({
        sessionId: Id,
        runId: Id,
        workspacePath: z.string().min(1),
        agent: AgentDefinitionRef,
        model: ModelRef,
        mode: RunMode,
        limits: RunLimits,
        history: z.array(CanonicalMessage),
      }),
      result: z.object({}),
    },
    /** 用户输入已由主进程落库为 message.user，messageId 与之对应。 */
    'host.prompt': {
      params: z.object({ messageId: Id, content: z.array(ContentPart).min(1) }),
      result: z.object({}),
    },
    'host.abort': {
      params: z.object({ reason: z.enum(['user', 'shutdown']) }),
      result: z.object({}),
    },
    'host.shutdown': {
      params: z.object({}),
      result: z.object({}),
    },
    /** 心跳：主进程定期请求，超时视为宿主卡死（架构 §21）。 */
    'host.heartbeat': {
      params: z.object({}),
      result: z.object({ ts: Timestamp }),
    },
  },
  events: {
    'host.event': z.object({ event: UnsequencedEventSchema }),
  },
})

/** 审批请求（host.approval.request / response）在 M1 加入。 */
export const MainForHost = defineSide({ requests: {}, events: {} })

export const RESERVED_HOST_MAIN_METHODS = ['host.approval.request'] as const
