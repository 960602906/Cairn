import type { Migration } from '../migrate.js'

/**
 * 会话思考强度（M3-13）：会话可以单独指定思考强度，下一轮生效；
 * 没有指定时用模型配置里的默认值。模型不支持推理时忽略这个字段。
 */
export const sessionThinkingLevel: Migration = {
  version: 17,
  name: 'session-thinking-level',
  up(db) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN thinking_level TEXT;
    `)
  },
}
