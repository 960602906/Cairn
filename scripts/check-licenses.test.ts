import { describe, expect, it } from 'vitest'
import { DEV_ONLY, PERMISSIVE, findViolations, isExpressionAllowed } from './check-licenses.js'

describe('isExpressionAllowed', () => {
  it.each([
    ['MIT', true],
    ['GPL-3.0-only', false],
    ['(MIT OR GPL-3.0)', true],
    ['MIT OR Apache-2.0', true],
    ['MIT AND GPL-2.0', false],
    ['(MIT AND Apache-2.0) OR GPL-3.0', true],
    ['GPL-3.0 OR (MIT AND LGPL-2.1)', false],
    ['UNKNOWN', false],
    ['', false],
  ])('%s → %s', (expr, expected) => {
    expect(isExpressionAllowed(expr, PERMISSIVE)).toBe(expected)
  })

  it('MPL-2.0 只在开发依赖中允许', () => {
    expect(isExpressionAllowed('MPL-2.0', PERMISSIVE)).toBe(false)
    expect(isExpressionAllowed('MPL-2.0', new Set([...PERMISSIVE, ...DEV_ONLY]))).toBe(true)
  })
})

describe('findViolations', () => {
  const report = {
    MIT: [{ name: 'ok', versions: ['1.0.0'], license: 'MIT' }],
    'GPL-3.0': [{ name: 'copyleft', versions: ['1.0.0', '2.0.0'], license: 'GPL-3.0' }],
  }

  it('引入 GPL 依赖时报告违规', () => {
    expect(findViolations(report, PERMISSIVE, {}, 'prod')).toEqual([
      { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0', scope: 'prod' },
      { name: 'copyleft', version: '2.0.0', license: 'GPL-3.0', scope: 'prod' },
    ])
  })

  it('例外按精确版本生效', () => {
    const v = findViolations(report, PERMISSIVE, { 'copyleft@1.0.0': 'reviewed' }, 'prod')
    expect(v.map((x) => x.version)).toEqual(['2.0.0'])
  })
})
