/**
 * 运行检查器服务（M4-04，管理界面 §8.2）：从事件日志投影运行树，保存宿主上报的上下文快照。
 *
 * 快照在写入前统一脱敏（用户主目录 → `~`，密钥格式由 `redact` 处理）并截断到单份上限；
 * 每个运行只保留最近 20 份。检查器只读，不修改运行或历史。
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fitSnapshot, projectRunTree, redact } from '@cairn/core'
import {
  RpcError,
  type PermissionRule,
  type RunInspectResult,
  type RunSnapshot,
  type RunSnapshotInput,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'

export const InspectServiceErrorCode = {
  NotFound: 'run.not_found',
} as const

export interface InspectServiceOptions {
  readonly storage: Storage
  readonly events: Pick<SessionEventService, 'readAfter'>
  readonly now?: () => number
  readonly createId?: () => string
  /** 当前用户主目录；测试可替换。 */
  readonly homeDir?: string
}

export interface InspectService {
  /** 保存一份宿主上报的快照，返回落库后的完整快照。 */
  record(sessionId: string, input: RunSnapshotInput): RunSnapshot
  inspect(params: { readonly sessionId: string; readonly runId?: string }): RunInspectResult
}

const normalize = (path: string) => path.replace(/[\\/]+/g, '/')

/** 项目内路径显示为相对路径；项目外把主目录换成 `~`。 */
export function redactWorkspacePath(path: string, projectPath: string, homeDir: string): string {
  const target = normalize(path)
  const project = normalize(projectPath).replace(/\/+$/, '')
  if (target === project) return '.'
  if (target.startsWith(`${project}/`)) return target.slice(project.length + 1)
  return redact(path, { homeDirs: [homeDir] })
}

export function createInspectService(options: InspectServiceOptions): InspectService {
  const { storage, events } = options
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const homeDir = options.homeDir ?? homedir()

  return {
    record(sessionId, input) {
      const clean = fitSnapshot(redact(input, { homeDirs: [homeDir] }))
      const record = storage.runSnapshots.add({
        snapshotId: createId(),
        sessionId,
        runId: clean.runId,
        ...(clean.parentRunId ? { parentRunId: clean.parentRunId } : {}),
        ...(clean.turnId ? { turnId: clean.turnId } : {}),
        ...(clean.stepId ? { stepId: clean.stepId } : {}),
        tokens: clean.tokens,
        data: clean,
      })
      return {
        ...(record.data as RunSnapshotInput),
        snapshotId: record.snapshotId,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
      }
    },

    inspect({ sessionId, runId }) {
      const session = storage.sessions.get(sessionId)
      if (!session) throw new RpcError(InspectServiceErrorCode.NotFound, { sessionId })
      const tree = projectRunTree({
        sessionId,
        events: events.readAfter(sessionId, 0),
        ...(runId ? { rootRunId: runId } : {}),
        generatedAt: now(),
      })
      if (tree.runs.length === 0 || tree.rootRunId === '') {
        throw new RpcError(InspectServiceErrorCode.NotFound, { sessionId, runId: runId ?? '' })
      }
      const snapshots: RunSnapshot[] = storage.runSnapshots
        .list(tree.rootRunId, 20)
        .map((record) => ({
          ...(record.data as RunSnapshotInput),
          snapshotId: record.snapshotId,
          sessionId: record.sessionId,
          createdAt: record.createdAt,
        }))
      const rules: PermissionRule[] = storage.permissionRules
        .list({ projectId: session.projectId, sessionId })
        .map((record) => record.rule)
      return {
        tree,
        snapshots,
        settings: {
          projectPath: redactWorkspacePath(session.projectPath, session.projectPath, homeDir),
          workspacePath: redactWorkspacePath(session.workspacePath, session.projectPath, homeDir),
          permissionRules: rules,
        },
      }
    },
  }
}
