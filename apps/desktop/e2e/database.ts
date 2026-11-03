/**
 * 端到端测试读取应用数据库（M0-16b）。以只读方式直接查询 `events` 表，不经过存储层，
 * 这样"增量没有落库"检查的是表中实际的内容。应在应用退出（数据库关闭）后读取。
 */
import path from 'node:path'
import Database from 'better-sqlite3'

export interface StoredEvent {
  readonly sessionId: string
  readonly seq: number
  readonly runId: string
  readonly turnId: string | null
  readonly type: string
  readonly payload: Record<string, unknown>
}

interface EventRow {
  readonly session_id: string
  readonly seq: number
  readonly run_id: string
  readonly turn_id: string | null
  readonly type: string
  readonly payload: string
}

export const databaseFile = (userData: string) => path.join(userData, 'data/nexus.db')

/** 按会话、seq 顺序读出全部事件。 */
export function readEvents(userData: string): StoredEvent[] {
  const db = new Database(databaseFile(userData), { readonly: true, fileMustExist: true })
  try {
    return db
      .prepare<[], EventRow>(
        'SELECT session_id, seq, run_id, turn_id, type, payload FROM events ORDER BY session_id, seq',
      )
      .all()
      .map((row) => ({
        sessionId: row.session_id,
        seq: row.seq,
        runId: row.run_id,
        turnId: row.turn_id,
        type: row.type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }))
  } finally {
    db.close()
  }
}

export const ofType = (events: readonly StoredEvent[], type: string) =>
  events.filter((event) => event.type === type)

/** 消息内容（`ContentPart[]`）中的文本。 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}
