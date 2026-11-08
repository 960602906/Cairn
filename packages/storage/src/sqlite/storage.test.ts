import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { describeStorageContract, userEvent } from '../testing/store-contract.js'
import { migrateDatabase } from './migrate.js'
import { MIGRATIONS } from './migrations/index.js'
import { openSqliteStorage } from './storage.js'

const dirs: string[] = []
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-sqlite-'))
  dirs.push(dir)
  return path.join(dir, 'cairn.db')
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describeStorageContract('sqlite', (now) => openSqliteStorage({ file: tempFile(), now }))

describe('openSqliteStorage', () => {
  let file: string

  beforeEach(() => {
    file = tempFile()
  })

  it('migrates a new database to the latest version and enables WAL', () => {
    const storage = openSqliteStorage({ file, now: () => 5 })
    expect(storage.migration).toEqual({
      from: 0,
      to: MIGRATIONS.length,
      applied: [
        '0001_init',
        '0002_providers',
        '0003_provider_compat',
        '0004_file_changes',
        '0005_permission_rules',
        '0006_project_settings',
        '0007_skill_prefs',
        '0008_project_skills_default',
        '0009_mcp',
        '0010_agents',
      ],
    })
    storage.close()

    const db = new Database(file, { readonly: true })
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toEqual([
      'agent_runs',
      'agent_versions',
      'agents',
      'events',
      'file_changes',
      'hunks',
      'mcp_servers',
      'mcp_tool_prefs',
      'permission_rules',
      'projects',
      'provider_configs',
      'schema_meta',
      'sessions',
      'skill_prefs',
    ])
    db.close()
  })

  it('keeps data across reopening without migrating again', () => {
    const first = openSqliteStorage({ file, now: () => 10 })
    first.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
    first.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: '/work/demo',
      title: '会话',
    })
    first.events.append([
      { ...userEvent('s1', 1), parentRunId: 'run-0', turnId: 't1', stepId: 'st1' },
      userEvent('s1', 2, '你好'),
    ])
    first.close()

    const second = openSqliteStorage({ file })
    expect(second.migration).toEqual({
      from: MIGRATIONS.length,
      to: MIGRATIONS.length,
      applied: [],
    })
    expect(second.sessions.list().map((s) => s.title)).toEqual(['会话'])
    expect(second.events.readAfter('s1', 0)).toEqual([
      { ...userEvent('s1', 1), parentRunId: 'run-0', turnId: 't1', stepId: 'st1' },
      userEvent('s1', 2, '你好'),
    ])
    expect(second.events.maxSeq('s1')).toBe(2)
    second.close()
  })

  it('turns project skills on for projects created before they became the default', () => {
    migrateDatabase({ file, migrations: MIGRATIONS.slice(0, 7) })
    const db = new Database(file)
    db.prepare(
      `INSERT INTO projects (project_id, name, path, created_at, read_agents_md, enable_project_skills)
       VALUES ('p1', 'Old', '/work/old', 1, 1, 0)`,
    ).run()
    db.close()

    const storage = openSqliteStorage({ file })
    expect(storage.migration.applied).toEqual([
      '0008_project_skills_default',
      '0009_mcp',
      '0010_agents',
    ])
    expect(storage.projects.get('p1')?.enableProjectSkills).toBe(true)
    storage.close()
  })

  it('uses Date.now by default', () => {
    const storage = openSqliteStorage({ file })
    const before = Date.now()
    const project = storage.projects.create({ projectId: 'p', name: 'P', path: '/p' })
    expect(project.createdAt).toBeGreaterThanOrEqual(before)
    storage.close()
  })

  it('refuses to be used after close', () => {
    const storage = openSqliteStorage({ file })
    storage.close()
    expect(() => storage.projects.list()).toThrow()
  })
})
