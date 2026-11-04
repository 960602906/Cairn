import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  binariesReport,
  DEV_ONLY,
  PERMISSIVE,
  findViolations,
  isExpressionAllowed,
  loadBundledBinaries,
  parseLicenseOutput,
  runLicenseCheck,
} from './check-licenses.js'

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

describe('parseLicenseOutput', () => {
  it('解析 JSON 输出', () => {
    expect(parseLicenseOutput('{"MIT":[]}\n')).toEqual({ MIT: [] })
  })

  it('没有依赖时 pnpm 输出提示文字，视为空报告', () => {
    expect(parseLicenseOutput('No licenses in packages found\n')).toEqual({})
  })
})

describe('runLicenseCheck', () => {
  const mit = JSON.stringify({ MIT: [{ name: 'ok', versions: ['1.0.0'], license: 'MIT' }] })
  const mpl = JSON.stringify({
    'MPL-2.0': [{ name: 'lightningcss', versions: ['1.0.0'], license: 'MPL-2.0' }],
  })

  function run(prod: string, dev: string, exceptions: Record<string, string> = {}) {
    const log: string[] = []
    const error: string[] = []
    const code = runLicenseCheck({
      listLicenses: (flag) => (flag === '--prod' ? prod : dev),
      exceptions,
      log: (l) => log.push(l),
      error: (l) => error.push(l),
    })
    return { code, log, error }
  }

  it('全部合规时返回 0', () => {
    const r = run(mit, 'No licenses in packages found')
    expect(r).toEqual({ code: 0, log: ['License check passed.'], error: [] })
  })

  it('开发依赖允许 MPL-2.0', () => {
    expect(run(mit, mpl).code).toBe(0)
  })

  it('生产依赖出现 MPL-2.0 时失败，并列出违规项与处理方法', () => {
    const r = run(mpl, mit)
    expect(r.code).toBe(1)
    expect(r.log).toEqual([])
    expect(r.error).toContain('  [prod] lightningcss@1.0.0: MPL-2.0')
    expect(r.error.at(-1)).toMatch(/license-exceptions\.json/)
  })

  it('登记例外后通过', () => {
    expect(run(mpl, mit, { 'lightningcss@1.0.0': 'reviewed' }).code).toBe(0)
  })

  it('外部二进制按生产依赖检查', () => {
    const binaries = binariesReport(
      [{ name: 'tool', version: '1.0.0', license: 'GPL-3.0-only', licenseDir: 'x' }],
      '/repo',
    )
    const r = runLicenseCheck({
      listLicenses: () => mit,
      binaries,
      exceptions: {},
      log: () => {},
      error: () => {},
    })
    expect(r).toBe(1)
  })
})

describe('bundled binaries', () => {
  const root = path.resolve(import.meta.dirname, '..')

  it('登记的二进制许可证允许，且带有许可证全文', () => {
    const binaries = loadBundledBinaries(root)
    expect(binaries.map((b) => b.name)).toContain('ripgrep')
    for (const b of binaries) {
      expect(isExpressionAllowed(b.license, PERMISSIVE)).toBe(true)
      expect(existsSync(path.join(root, b.licenseDir, 'LICENSE'))).toBe(true)
    }
  })

  it('转为 pnpm licenses 的格式', () => {
    expect(
      binariesReport(
        [
          {
            name: 'rg',
            version: '1',
            license: 'MIT',
            author: 'A',
            homepage: 'https://h',
            licenseDir: 'lic/rg',
          },
          { name: 'bare', version: '2', license: 'MIT', licenseDir: 'lic/bare' },
        ],
        '/repo',
      ),
    ).toEqual({
      'bundled binaries': [
        {
          name: 'rg',
          versions: ['1'],
          paths: [path.join('/repo', 'lic/rg')],
          license: 'MIT',
          author: 'A',
          homepage: 'https://h',
        },
        { name: 'bare', versions: ['2'], paths: [path.join('/repo', 'lic/bare')], license: 'MIT' },
      ],
    })
  })
})
