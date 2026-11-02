// S4 SQLite 引擎预研：对两个引擎执行同一组检查，输出可比较的结果。
// 在纯 Node、Electron 主进程和打包后的应用中复用（见 cli.mjs、main.mjs）。
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)

/** 批量写入的事件数（模拟会话事件表）。 */
const BATCH_EVENTS = 20_000
const BATCH_SIZE = 100
/** 每次一个事务（自动提交）的写入数，模拟流式过程中逐条落库。 */
const SINGLE_INSERTS = 1_000

/**
 * 两个引擎的最小公共接口。
 * @typedef {{
 *   name: string
 *   version: () => string
 *   open: (file: string) => Db
 * }} Engine
 * @typedef {{
 *   exec: (sql: string) => void
 *   run: (sql: string, ...params: unknown[]) => void
 *   get: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined
 *   all: (sql: string, ...params: unknown[]) => Record<string, unknown>[]
 *   prepare: (sql: string) => { run: (...params: unknown[]) => void }
 *   close: () => void
 * }} Db
 */

/** @returns {Engine} */
function betterSqlite3() {
  const Database = require('better-sqlite3')
  return {
    name: 'better-sqlite3',
    version: () => require('better-sqlite3/package.json').version,
    open(file) {
      const db = new Database(file)
      const cache = new Map()
      const stmt = (sql) => {
        let s = cache.get(sql)
        if (!s) cache.set(sql, (s = db.prepare(sql)))
        return s
      }
      return {
        exec: (sql) => void db.exec(sql),
        run: (sql, ...p) => void stmt(sql).run(...p),
        get: (sql, ...p) => stmt(sql).get(...p),
        all: (sql, ...p) => stmt(sql).all(...p),
        prepare: (sql) => {
          const s = db.prepare(sql)
          return { run: (...p) => void s.run(...p) }
        },
        close: () => db.close(),
      }
    },
  }
}

/** @returns {Engine} */
function nodeSqlite() {
  const { DatabaseSync } = require('node:sqlite')
  return {
    name: 'node:sqlite',
    version: () => process.versions.node,
    open(file) {
      const db = new DatabaseSync(file)
      const cache = new Map()
      const stmt = (sql) => {
        let s = cache.get(sql)
        if (!s) cache.set(sql, (s = db.prepare(sql)))
        return s
      }
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...p) => void stmt(sql).run(...p),
        get: (sql, ...p) => stmt(sql).get(...p),
        all: (sql, ...p) => stmt(sql).all(...p),
        prepare: (sql) => {
          const s = db.prepare(sql)
          return { run: (...p) => void s.run(...p) }
        },
        close: () => db.close(),
      }
    },
  }
}

export const ENGINES = { 'better-sqlite3': betterSqlite3, 'node:sqlite': nodeSqlite }

const SCHEMA = `
  CREATE TABLE events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;
  CREATE INDEX events_type ON events (type);
`

const INSERT =
  'INSERT INTO events (session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)'

const payload = JSON.stringify({
  text: '你好，NEXUS-OS '.repeat(8),
  usage: { input: 1200, output: 340 },
})

/** 在显式事务中执行 fn，抛错时回滚。 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    fn()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function check(name, fn) {
  try {
    const detail = fn()
    return { name, ok: true, ...(detail === undefined ? {} : { detail }) }
  } catch (error) {
    return { name, ok: false, error: String(error?.stack ?? error) }
  }
}

function time(fn) {
  const start = performance.now()
  fn()
  return Math.round((performance.now() - start) * 10) / 10
}

/**
 * 对一个引擎执行全部检查。任何一步失败都记录在结果中，不中断其他检查。
 * @param {keyof typeof ENGINES} engineName
 */
export function runEngine(engineName) {
  const result = { engine: engineName, checks: [], metrics: {} }
  const dir = mkdtempSync(path.join(tmpdir(), 'nexus-s4-'))
  try {
    /** @type {Engine} */
    let engine
    result.metrics.loadMs = time(() => {
      engine = ENGINES[engineName]()
    })
    result.version = engine.version()

    const file = path.join(dir, 'nexus.db')
    const db = engine.open(file)
    result.sqliteVersion = db.get('SELECT sqlite_version() AS v').v

    result.checks.push(
      check('wal', () => {
        const mode = db.get('PRAGMA journal_mode = WAL').journal_mode
        db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
        if (mode !== 'wal') throw new Error(`journal_mode = ${mode}`)
        return mode
      }),
    )

    db.exec(SCHEMA)

    result.checks.push(
      check('transaction.commit', () => {
        tx(db, () => db.run(INSERT, 'tx', 1, 'message.user', payload, Date.now()))
        const n = db.get("SELECT count(*) AS n FROM events WHERE session_id = 'tx'").n
        if (Number(n) !== 1) throw new Error(`rows = ${n}`)
      }),
    )

    result.checks.push(
      check('transaction.rollback', () => {
        try {
          tx(db, () => {
            db.run(INSERT, 'tx', 2, 'message.user', payload, Date.now())
            // 主键冲突，整个事务应回滚
            db.run(INSERT, 'tx', 1, 'message.user', payload, Date.now())
          })
        } catch {
          // 预期
        }
        const n = db.get("SELECT count(*) AS n FROM events WHERE session_id = 'tx'").n
        if (Number(n) !== 1) throw new Error(`rows after rollback = ${n}`)
      }),
    )

    result.checks.push(
      check('transaction.savepoint', () => {
        tx(db, () => {
          db.run(INSERT, 'sp', 1, 'a', payload, Date.now())
          db.exec('SAVEPOINT inner')
          db.run(INSERT, 'sp', 2, 'b', payload, Date.now())
          db.exec('ROLLBACK TO inner')
          db.exec('RELEASE inner')
        })
        const n = db.get("SELECT count(*) AS n FROM events WHERE session_id = 'sp'").n
        if (Number(n) !== 1) throw new Error(`rows = ${n}`)
      }),
    )

    result.checks.push(
      check('wal.concurrent-reader', () => {
        // WAL 下，写事务进行中另一个连接仍可读到已提交的数据
        const reader = engine.open(file)
        try {
          db.exec('BEGIN IMMEDIATE')
          db.run(INSERT, 'wal', 1, 'a', payload, Date.now())
          const before = reader.get("SELECT count(*) AS n FROM events WHERE session_id = 'tx'").n
          db.exec('COMMIT')
          if (Number(before) !== 1) throw new Error(`reader saw ${before}`)
        } finally {
          reader.close()
        }
      }),
    )

    result.checks.push(
      check('throughput.batched', () => {
        const insert = db.prepare(INSERT)
        const ms = time(() => {
          for (let b = 0; b < BATCH_EVENTS / BATCH_SIZE; b++) {
            tx(db, () => {
              for (let i = 0; i < BATCH_SIZE; i++) {
                const seq = b * BATCH_SIZE + i + 1
                insert.run('batch', seq, 'message.assistant', payload, Date.now())
              }
            })
          }
        })
        result.metrics.batchedInsertMs = ms
        result.metrics.batchedRowsPerSec = Math.round((BATCH_EVENTS / ms) * 1000)
      }),
    )

    result.checks.push(
      check('throughput.autocommit', () => {
        const insert = db.prepare(INSERT)
        const ms = time(() => {
          for (let i = 1; i <= SINGLE_INSERTS; i++) {
            insert.run('single', i, 'tool.completed', payload, Date.now())
          }
        })
        result.metrics.autocommitInsertMs = ms
        result.metrics.autocommitRowsPerSec = Math.round((SINGLE_INSERTS / ms) * 1000)
      }),
    )

    result.checks.push(
      check('read.session', () => {
        let rows = []
        result.metrics.readSessionMs = time(() => {
          rows = db.all(
            "SELECT seq, type, payload FROM events WHERE session_id = 'batch' ORDER BY seq",
          )
        })
        if (rows.length !== BATCH_EVENTS) throw new Error(`rows = ${rows.length}`)
        JSON.parse(String(rows.at(-1).payload))
      }),
    )

    result.checks.push(check('wal.checkpoint', () => db.get('PRAGMA wal_checkpoint(TRUNCATE)')))

    db.close()
  } catch (error) {
    result.checks.push({ name: 'load', ok: false, error: String(error?.stack ?? error) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  result.ok = result.checks.length > 0 && result.checks.every((c) => c.ok)
  return result
}

/** 运行全部引擎，附带运行环境信息。 */
export async function runAll(context) {
  const engines = []
  let current = null
  const onWarning = (w) => current?.warnings.push(`${w.name}: ${w.message}`)
  process.on('warning', onWarning)
  for (const name of Object.keys(ENGINES)) {
    current = { ...runEngine(name), warnings: [] }
    engines.push(current)
    // process 'warning' 事件异步派发，等一轮再切换到下一个引擎
    await new Promise((r) => setTimeout(r, 10))
  }
  process.off('warning', onWarning)
  return {
    context,
    platform: `${process.platform}-${process.arch}`,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      modules: process.versions.modules,
      napi: process.versions.napi,
      bundledSqlite: process.versions.sqlite ?? null,
    },
    engines,
    ok: engines.every((e) => e.ok),
  }
}
