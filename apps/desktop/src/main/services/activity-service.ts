/**
 * 活动中心聚合（M4-06，管理界面 §9，ADR-0032）。
 *
 * - 审批来自审批服务的全局索引；运行与最近完成从事件日志按需投影，不维护第二份事件日志。
 * - `activity.list` 返回当前快照；`activity.resolve` 按 approvalId 路由到审批服务。
 * - 订阅只用于“有变化”的推送与通知；快照始终在读取时重新计算，避免与事件日志漂移。
 */
import { projectRunTree, redact } from '@cairn/core'
import {
  RpcError,
  type ActivityApproval,
  type ActivityCompleted,
  type ActivityCompletedStatus,
  type ActivityDecision,
  type ActivityListResult,
  type ActivityRunning,
  type EventEnvelope,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import type { ApprovalService } from './approval-service.js'
import type { SessionEventService } from './event-service.js'

export const ACTIVITY_COMPLETED_LIMIT = 20
const SUMMARY_MAX_CHARS = 120

export interface ActivityChange {
  readonly reason: 'approvals' | 'completed' | 'runs'
  readonly sessionId?: string
  /** 本次新出现的审批；清空或取消时为空。 */
  readonly approvals: readonly ActivityApproval[]
  /** 本次新完成的轮次；只有完成事件会带上。 */
  readonly completed: readonly ActivityCompleted[]
}

export interface ActivityServiceOptions {
  readonly storage: Pick<Storage, 'sessions'>
  readonly events: Pick<SessionEventService, 'readAfter' | 'subscribe'>
  readonly approvals: Pick<ApprovalService, 'list' | 'resolve' | 'subscribe'>
  readonly now?: () => number
  readonly homeDirs?: readonly string[]
  readonly secrets?: () => readonly string[]
  readonly onError?: (error: unknown) => void
}

export interface ResolveActivityParams {
  readonly approvalId: string
  readonly decision: ActivityDecision
  readonly feedback?: string | undefined
}

export interface ActivityService {
  list(): ActivityListResult
  resolve(params: ResolveActivityParams): Record<string, never>
  subscribe(listener: (change: ActivityChange) => void): () => void
  close(): void
}

interface RunInfo {
  readonly agent: ActivityCompleted['agent']
  readonly parentRunId?: string
}

function cleanText(
  value: string,
  options: ActivityServiceOptions,
  max = SUMMARY_MAX_CHARS,
): string {
  const redacted = redact(value, {
    homeDirs: options.homeDirs ?? [],
    secrets: options.secrets?.() ?? [],
  })
  return redacted.replace(/\s+/g, ' ').trim().slice(0, max)
}

function eventText(event: EventEnvelope<'message.user'>): string {
  return event.payload.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
}

function approvalOf(
  entry: ReturnType<ApprovalService['list']>[number],
  title: string,
  options: ActivityServiceOptions,
): ActivityApproval {
  const request = entry.request
  const summary =
    request.preview?.summary ??
    request.targets.command ??
    request.targets.paths?.join(', ') ??
    request.tool.name
  return {
    approvalId: request.approvalId,
    sessionId: entry.sessionId,
    sessionTitle: title,
    runId: request.runId,
    ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
    agent: request.agent,
    toolName: request.tool.name,
    toolCategory: request.tool.category,
    kind: request.kind,
    summary: cleanText(summary, options, 160),
    reasonCode: request.reasonCode,
    matchedRuleIds: [...request.matchedRuleIds],
    requestedAt: entry.requestedAt,
  }
}

export function createActivityService(options: ActivityServiceOptions): ActivityService {
  const listeners = new Set<(change: ActivityChange) => void>()
  const emit = (change: ActivityChange): void => {
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        options.onError?.(error)
      }
    }
  }

  const sessions = () => options.storage.sessions.list()
  const sessionMap = () => new Map(sessions().map((session) => [session.sessionId, session]))

  const currentApprovals = (): ActivityApproval[] => {
    const sessionById = sessionMap()
    return options.approvals
      .list()
      .map((entry) => approvalOf(entry, sessionById.get(entry.sessionId)?.title ?? '', options))
  }

  let knownApprovals = new Set(currentApprovals().map((item) => item.approvalId))
  const unsubscribeApprovals = options.approvals.subscribe(() => {
    const current = currentApprovals()
    const known = knownApprovals
    const added = current.filter((item) => !known.has(item.approvalId))
    knownApprovals = new Set(current.map((item) => item.approvalId))
    emit({
      reason: 'approvals',
      approvals: added,
      completed: [],
      ...(added.length > 0 ? { sessionId: added[0]!.sessionId } : {}),
    })
  })

  const scanSession = (
    sessionId: string,
    title: string,
  ): { running?: ActivityRunning; completed: ActivityCompleted[] } => {
    const events = options.events.readAfter(sessionId, 0)
    if (events.length === 0) return { completed: [] }
    if (events.some((event) => event.type === 'session.archived')) return { completed: [] }
    const crashed = events.some((event) => event.type === 'session.crashed')

    const runInfo = new Map<string, RunInfo>()
    const turnLimit = new Set<string>()
    const turnText = new Map<string, string>()
    /** 父运行每一轮最近一个子运行产生的改动集：`runId:turnId` → changeSetId。 */
    const turnChangeSets = new Map<string, string>()
    /** 父运行最近一个子运行的改动集；没有 turnId 时回退到它。 */
    const runChangeSets = new Map<string, string>()
    const terminal = new Map<string, ActivityCompleted>()
    let lastText = ''

    for (const event of events) {
      switch (event.type) {
        case 'run.created':
          runInfo.set(event.runId, {
            agent: event.payload.agent,
            ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
          })
          break
        case 'message.user': {
          lastText = cleanText(eventText(event), options)
          if (event.turnId) turnText.set(event.turnId, lastText)
          break
        }
        case 'turn.limit_reached':
          if (event.turnId) turnLimit.add(event.turnId)
          break
        case 'run.child.completed':
          if (event.payload.changeSetId !== undefined) {
            turnChangeSets.set(`${event.runId}:${event.turnId ?? ''}`, event.payload.changeSetId)
            runChangeSets.set(event.runId, event.payload.changeSetId)
          }
          break
        case 'turn.completed':
        case 'turn.aborted':
        case 'turn.failed': {
          const info = runInfo.get(event.runId)
          if (!info || info.parentRunId !== undefined) break
          const status: ActivityCompletedStatus =
            event.type === 'turn.completed'
              ? 'completed'
              : event.type === 'turn.aborted'
                ? 'aborted'
                : event.turnId && turnLimit.has(event.turnId)
                  ? 'limit_reached'
                  : 'failed'
          const key = `${event.runId}:${event.turnId ?? ''}`
          const changeSetId =
            turnChangeSets.get(key) ??
            (event.turnId === undefined ? runChangeSets.get(event.runId) : undefined)
          terminal.set(key, {
            sessionId,
            sessionTitle: title,
            runId: event.runId,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            agent: info.agent,
            status,
            summary: (event.turnId ? turnText.get(event.turnId) : undefined) ?? lastText,
            completedAt: event.ts,
            ...(changeSetId === undefined ? {} : { changeSetId }),
          })
          break
        }
        default:
          break
      }
    }

    const tree = projectRunTree({ sessionId, events, generatedAt: options.now?.() ?? Date.now() })
    const root = tree.runs.findLast((run) => run.parentRunId === undefined)
    let running: ActivityRunning | undefined
    if (
      !crashed &&
      root &&
      (root.state === 'thinking' ||
        root.state === 'tooling' ||
        root.state === 'awaiting_children' ||
        root.state === 'aborting')
    ) {
      const turn = root.turns.at(-1)
      const step = turn?.steps.at(-1)
      const tool = step?.toolCalls.findLast(
        (call) => call.status === 'requested' || call.status === 'running',
      )
      running = {
        sessionId,
        sessionTitle: title,
        runId: root.runId,
        agent: root.agent,
        mode: root.mode,
        state: root.state,
        summary: lastText,
        ...(tool ? { step: tool.name } : step ? { step: step.stepId } : {}),
        startedAt: root.createdAt,
        updatedAt: root.updatedAt,
      }
    }

    return { ...(running ? { running } : {}), completed: [...terminal.values()] }
  }

  const snapshot = (): ActivityListResult => {
    const approvals = currentApprovals()
    const running: ActivityRunning[] = []
    const completed: ActivityCompleted[] = []
    for (const session of sessions()) {
      try {
        const result = scanSession(session.sessionId, session.title)
        if (result.running) running.push(result.running)
        completed.push(...result.completed)
      } catch (error) {
        options.onError?.(error)
      }
    }
    running.sort((a, b) => b.updatedAt - a.updatedAt)
    completed.sort((a, b) => b.completedAt - a.completedAt)
    const recent = completed.slice(0, ACTIVITY_COMPLETED_LIMIT)
    return {
      approvals,
      running,
      completed: recent,
      counts: { approvals: approvals.length, running: running.length },
    }
  }

  const runAffecting = new Set([
    'run.state.changed',
    'session.archived',
    'session.crashed',
    'session.renamed',
    'message.user',
  ])
  const terminalEvents = new Set(['turn.completed', 'turn.aborted', 'turn.failed'])
  const unsubscribeEvents = options.events.subscribe((sessionId, batch) => {
    const completed: ActivityCompleted[] = []
    let runs = false
    let terminal = false
    for (const event of batch) {
      if (runAffecting.has(event.type)) runs = true
      if (terminalEvents.has(event.type)) terminal = true
    }
    if (terminal) {
      const session = options.storage.sessions.get(sessionId)
      if (session) {
        try {
          completed.push(...scanSession(sessionId, session.title).completed)
        } catch (error) {
          options.onError?.(error)
        }
      }
    }
    if (!runs && completed.length === 0) return
    emit({
      reason: completed.length > 0 ? 'completed' : 'runs',
      sessionId,
      approvals: [],
      completed,
    })
  })

  return {
    list: snapshot,

    resolve({ approvalId, decision, feedback }) {
      const entry = options.approvals.list().find((item) => item.request.approvalId === approvalId)
      if (!entry) throw new RpcError('approval.not_found', { approvalId })
      options.approvals.resolve({
        sessionId: entry.sessionId,
        approvalId,
        decision,
        ...(feedback ? { feedback } : {}),
      })
      return {}
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    close() {
      unsubscribeApprovals()
      unsubscribeEvents()
      listeners.clear()
    },
  }
}
