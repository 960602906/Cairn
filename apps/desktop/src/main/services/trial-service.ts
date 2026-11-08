/**
 * Agent 试运行（M4-12，管理界面 §6）。
 *
 * 试运行是标记为 `trial` 的普通会话：事件、检查点与改动记录走同一套基础设施，但不出现在
 * `session.list`、活动中心与用量统计中。每次开始/重启都会用当前草稿计算新的内容哈希；
 * 历史事件保留当时的哈希，草稿变化不会改写旧记录。
 */
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { presetRules } from '@cairn/core'
import {
  RpcError,
  type PermissionRule,
  type RunAgentRef,
  type TrialStarted,
  type TrialSummary,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import type { AgentService } from './agent-service.js'
import type { SessionEventService } from './event-service.js'
import type { SessionManager } from './session-manager.js'

/** 每个 Agent 保留的试运行条数。 */
export const TRIAL_RETENTION = 10

export const TrialErrorCode = {
  NotFound: 'trial.not_found',
} as const

export interface TrialServiceOptions {
  readonly storage: Pick<Storage, 'projects' | 'sessions'>
  readonly events: Pick<SessionEventService, 'publish'>
  readonly agents: Pick<AgentService, 'trialDraft' | 'permissionRulesFor'>
  readonly sessions: Pick<SessionManager, 'isBusy'>
  readonly createId?: () => string
  readonly now?: () => number
}

export interface TrialCommands {
  start(input: {
    agentId: string
    projectPath: string
    useAgentPermissions?: boolean | undefined
  }): TrialStarted
  restart(input: { sessionId: string; useAgentPermissions?: boolean | undefined }): TrialStarted
  clear(input: { agentId: string }): { cleared: number }
  list(input: { agentId: string }): { trials: TrialSummary[] }
}

export interface TrialService extends TrialCommands {
  /** 试运行的权限规则：默认只读，显式提权后使用草稿 Agent 的权限预设。 */
  permissionRulesFor(
    sessionId: string,
    agent: RunAgentRef,
    rules: readonly PermissionRule[],
  ): PermissionRule[]
}

export function createTrialService(options: TrialServiceOptions): TrialService {
  const { storage, events, agents, sessions } = options
  const createId = options.createId ?? randomUUID
  const now = options.now ?? Date.now
  const elevated = new Set<string>()

  const trialsOf = (agentId: string): TrialSummary[] =>
    storage.sessions.list({ includeTrial: true }).flatMap((session) => {
      if (
        session.kind !== 'trial' ||
        session.trialAgentId !== agentId ||
        session.trialDraftHash === undefined
      ) {
        return []
      }
      return [
        {
          sessionId: session.sessionId,
          agent: { id: agentId, draftHash: session.trialDraftHash },
          projectPath: session.projectPath,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      ]
    })

  const prune = (agentId: string): void => {
    for (const trial of trialsOf(agentId).slice(TRIAL_RETENTION)) {
      if (sessions.isBusy(trial.sessionId)) continue
      storage.sessions.remove(trial.sessionId)
      elevated.delete(trial.sessionId)
    }
  }

  const createTrial = (
    agentId: string,
    projectPath: string,
    useAgentPermissions: boolean,
  ): TrialStarted => {
    if (!isAbsolute(projectPath)) {
      throw new RpcError('rpc.invalid_params', { projectPath })
    }
    const draft = agents.trialDraft(agentId)
    const project =
      storage.projects.getByPath(projectPath) ??
      storage.projects.create({
        projectId: createId(),
        name: basename(projectPath),
        path: projectPath,
      })
    const sessionId = createId()
    const at = now()
    storage.sessions.create({
      sessionId,
      projectId: project.projectId,
      workspacePath: project.path,
      title: '',
      kind: 'trial',
      trialAgentId: agentId,
      trialDraftHash: draft.draftHash,
    })
    events.publish([
      {
        v: 1,
        sessionId,
        runId: sessionId,
        ts: at,
        type: 'session.created',
        payload: {
          projectId: project.projectId,
          projectPath: project.path,
          workspacePath: project.path,
          title: '',
        },
      },
    ])
    if (useAgentPermissions) elevated.add(sessionId)
    prune(agentId)
    return {
      sessionId,
      agent: { id: agentId, draftHash: draft.draftHash },
      draftHash: draft.draftHash,
      useAgentPermissions,
    }
  }

  return {
    start({ agentId, projectPath, useAgentPermissions = false }) {
      return createTrial(agentId, projectPath, useAgentPermissions)
    },

    restart({ sessionId, useAgentPermissions }) {
      const session = storage.sessions.get(sessionId)
      if (
        !session ||
        session.kind !== 'trial' ||
        session.trialAgentId === undefined ||
        session.trialDraftHash === undefined
      ) {
        throw new RpcError(TrialErrorCode.NotFound, { sessionId })
      }
      return createTrial(session.trialAgentId, session.projectPath, useAgentPermissions ?? false)
    },

    clear({ agentId }) {
      const trials = trialsOf(agentId)
      const busy = trials.find((trial) => sessions.isBusy(trial.sessionId))
      if (busy) throw new RpcError('run.busy', { sessionId: busy.sessionId })
      for (const trial of trials) {
        storage.sessions.remove(trial.sessionId)
        elevated.delete(trial.sessionId)
      }
      return { cleared: trials.length }
    },

    list({ agentId }) {
      return { trials: trialsOf(agentId) }
    },

    permissionRulesFor(sessionId, agent, rules) {
      const session = storage.sessions.get(sessionId)
      if (!session || session.kind !== 'trial') {
        return agents.permissionRulesFor(agent, rules)
      }
      if (elevated.has(sessionId)) {
        return agents.permissionRulesFor(agent, rules)
      }
      return [...presetRules('read-only'), ...rules]
    },
  }
}
