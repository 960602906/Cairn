import type { Migration } from '../migrate.js'

export const backgroundCommands: Migration = {
  version: 15,
  name: 'background-commands',
  up(db) {
    db.exec(`
      CREATE TABLE background_commands (
        command_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        status TEXT NOT NULL,
        output TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions (session_id) ON DELETE CASCADE
      );
      CREATE INDEX background_commands_by_start ON background_commands (started_at DESC);
    `)
  },
}
