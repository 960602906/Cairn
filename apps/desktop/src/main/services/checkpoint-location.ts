/**
 * 会话的检查点位置（M1-12b，ADR-0008）：每个项目一个影子仓库（`<checkpoints>/<projectId>.git`），
 * 同一项目的会话共用对象，各用自己的引用 `refs/nexus/sessions/<sessionId>`。
 */
import { join } from 'node:path'
import type { Storage } from '@nexus/storage'
import type { HostCheckpointLocation } from './host-supervisor.js'

/** id 只用于目录名与引用名：只保留安全字符，其他情况不创建检查点。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function checkpointLocation(
  root: string,
  storage: Pick<Storage, 'sessions'>,
  sessionId: string,
): HostCheckpointLocation | undefined {
  const session = storage.sessions.get(sessionId)
  if (!session || !SAFE_ID.test(session.projectId) || !SAFE_ID.test(sessionId)) return undefined
  return {
    gitDir: join(root, `${session.projectId}.git`),
    ref: `refs/nexus/sessions/${sessionId}`,
  }
}
