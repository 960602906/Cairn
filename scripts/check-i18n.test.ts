import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareLocales, loadLocales, runI18nCheck } from './check-i18n.js'

const ok = {
  'zh-CN': { common: { 'action.ok': '确定' }, errors: { unknown: '未知错误' } },
  'en-US': { common: { 'action.ok': 'OK' }, errors: { unknown: 'Unknown error' } },
}

function run(resources: Parameters<typeof runI18nCheck>[0]['resources']) {
  const out: string[] = []
  const err: string[] = []
  const code = runI18nCheck({ resources, log: (l) => out.push(l), error: (l) => err.push(l) })
  return { code, out, err }
}

describe('compareLocales', () => {
  it('accepts identical key sets', () => {
    expect(compareLocales(ok)).toEqual([])
  })

  it('reports a key deleted from one locale', () => {
    const broken = structuredClone(ok) as Record<string, Record<string, Record<string, unknown>>>
    delete broken['en-US']!.common!['action.ok']
    expect(compareLocales(broken)).toEqual([
      { locale: 'en-US', namespace: 'common', key: 'action.ok', kind: 'missing_key' },
    ])
  })

  it('reports keys missing on either side and missing namespace files', () => {
    expect(
      compareLocales({
        'zh-CN': { common: { a: '一', b: '二' }, session: { s: '会话' } },
        'en-US': { common: { a: 'one', c: 'three' } },
      }),
    ).toEqual([
      { locale: 'en-US', namespace: 'common', key: 'b', kind: 'missing_key' },
      { locale: 'zh-CN', namespace: 'common', key: 'c', kind: 'missing_key' },
      { locale: 'en-US', namespace: 'session', kind: 'missing_namespace' },
    ])
  })

  it('rejects empty, non-string and nested values', () => {
    expect(
      compareLocales({
        'zh-CN': { common: { a: ' ', b: 1, c: { nested: 'x' } } },
        'en-US': { common: { a: 'A', b: 'B', c: 'C' } },
      }).map((p) => `${p.locale}:${p.key}:${p.kind}`),
    ).toEqual(['zh-CN:a:invalid_value', 'zh-CN:b:invalid_value', 'zh-CN:c:invalid_value'])
  })
})

describe('runI18nCheck', () => {
  it('passes and exits 0 when consistent', () => {
    expect(run(ok)).toEqual({ code: 0, out: ['i18n check passed (en-US, zh-CN).'], err: [] })
  })

  it('fails with readable messages', () => {
    const { code, err } = run({
      'zh-CN': { common: { a: '一', b: '' } },
      'en-US': { common: { b: 'B' }, errors: { unknown: 'x' } },
    })
    expect(code).toBe(1)
    expect(err).toEqual([
      'i18n check failed (ADR-0013): locales must have the same keys.',
      '  en-US/common.json: missing key "a"',
      '  zh-CN/common.json: "b" must be a non-empty string',
      '  zh-CN/errors.json: file is missing',
    ])
  })

  it('requires at least two locales', () => {
    expect(run({ 'zh-CN': ok['zh-CN'] }).code).toBe(1)
  })
})

describe('loadLocales', () => {
  it('reads locale directories and ignores other files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cairn-i18n-'))
    try {
      mkdirSync(path.join(dir, 'zh-CN'))
      writeFileSync(path.join(dir, 'zh-CN', 'common.json'), '{"a":"一"}')
      writeFileSync(path.join(dir, 'zh-CN', 'notes.txt'), 'ignored')
      writeFileSync(path.join(dir, 'README.md'), 'ignored')
      expect(loadLocales(dir)).toEqual({ 'zh-CN': { common: { a: '一' } } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds the repository locales consistent', () => {
    const resources = loadLocales(path.resolve(import.meta.dirname, '../packages/i18n/locales'))
    expect(Object.keys(resources).sort()).toEqual(['en-US', 'zh-CN'])
    expect(compareLocales(resources)).toEqual([])
  })
})
