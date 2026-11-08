import { expect, it } from 'vitest'
import * as storage from './index.js'

it('exports the public API', () => {
  expect(storage.createMemoryStorage).toBeTypeOf('function')
  expect(storage.StorageError).toBeTypeOf('function')
  expect(storage.migrateDatabase).toBeTypeOf('function')
  expect(storage.openSqliteStorage).toBeTypeOf('function')
  expect(storage.MIGRATIONS.map((m) => m.name)).toEqual([
    'init',
    'providers',
    'provider_compat',
    'file_changes',
    'permission_rules',
    'project_settings',
    'skill_prefs',
    'project_skills_default',
    'mcp',
    'agents',
    'run-snapshots',
  ])
  expect(storage.StorageErrorCode.SeqConflict).toBe('storage.seq_conflict')
  const error = new storage.StorageError(storage.StorageErrorCode.NotFound)
  expect(error.params).toEqual({})
  expect(error.message).toBe('storage.not_found {}')
})
