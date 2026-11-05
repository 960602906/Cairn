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
  RunState,
  Timestamp,
} from '../common.js'
import { FileChangeInput } from '../changes.js'
import { UnsequencedEventSchema } from '../events.js'
import { PermissionRule } from '../permissions.js'
import { BaseUrl, ModelCompat, ModelProfile, ProviderKind } from '../providers.js'
import { defineSide } from '../rpc.js'

/**
 * 宿主构造模型所需的配置（M1-04b）：由主进程按提供方配置给出，不含 Key。
 * `compat` 已合并提供方与模型两级的兼容参数。
 */
export const HostModelConfig = z.object({
  kind: ProviderKind,
  baseUrl: BaseUrl,
  profile: ModelProfile.omit({ compat: true, displayName: true, verifiedAt: true }),
  compat: ModelCompat.optional(),
})
export type HostModelConfig = z.infer<typeof HostModelConfig>

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
        /**
         * 恢复已有的运行（不再发出 run.created）：运行当前记录的状态。运行中状态按中断处理
         * （Runtime §13.2）。省略表示新运行。
         */
        resume: z.object({ state: RunState }).optional(),
        /**
         * 模型的凭据（ADR-0010，M1-03b）：主进程解密后只经这里传给宿主，不写入环境变量与日志。
         * 没有保存凭据时省略（如本地模型、FakeRuntime）。
         */
        credential: z.object({ apiKey: z.string().min(1) }).optional(),
        /** 模型配置（M1-04b）。省略时宿主用 FakeRuntime，或开发用的环境变量。 */
        modelConfig: HostModelConfig.optional(),
        /**
         * 适用于这个会话的权限规则（M1-10c）：权限模式的预设、全局规则、会话所属项目的规则、会话的规则。
         * 省略时按“询问”模式的预设判定。
         */
        permissionRules: z.array(PermissionRule).optional(),
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

/** 审批请求（host.approval.request / response）在 M1-11 加入。 */
export const MainForHost = defineSide({
  requests: {
    /**
     * 记录一次文件改动（M1-08b）：主进程把前后内容写入 blob 存储、写入改动记录，返回记录 id。
     * 会话与运行由连接确定。宿主随后发出 `file.changed`。
     */
    'changes.record': {
      params: FileChangeInput,
      result: z.object({ changeId: Id }),
    },
  },
  events: {},
})

export const RESERVED_HOST_MAIN_METHODS = ['host.approval.request'] as const
