// @ts-check
/**
 * 依赖许可证检查（ADR-0014）。
 *
 * - 生产依赖（随应用分发）：只允许 PERMISSIVE 中的许可证。
 * - 开发依赖（不分发）：额外允许 DEV_ONLY 中的弱著佐权许可证。
 * - 随应用分发的外部二进制（scripts/bundled-binaries.json，如 ripgrep）：与生产依赖相同。
 * - 其余许可证（含 GPL、AGPL、LGPL 与未知许可证）一律失败，
 *   除非在 scripts/license-exceptions.json 中按 "name@version" 登记并写明理由。
 *
 * 用法：node scripts/check-licenses.js
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
])

/** 只用于开发工具链、不随应用分发时可接受的许可证。 */
export const DEV_ONLY = new Set(['MPL-2.0'])

/**
 * 判断 SPDX 许可证表达式是否被允许。支持 OR / AND 与括号；
 * OR 只要一侧允许即可，AND 要求两侧都允许。
 * @param {string} expression
 * @param {Set<string>} allowed
 * @returns {boolean}
 */
export function isExpressionAllowed(expression, allowed) {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/)
  let i = 0
  /** @returns {boolean} */
  function parseOr() {
    let value = parseAnd()
    while (tokens[i]?.toUpperCase() === 'OR') {
      i++
      const rhs = parseAnd()
      value = value || rhs
    }
    return value
  }
  /** @returns {boolean} */
  function parseAnd() {
    let value = parseAtom()
    while (tokens[i]?.toUpperCase() === 'AND') {
      i++
      const rhs = parseAtom()
      value = value && rhs
    }
    return value
  }
  /** @returns {boolean} */
  function parseAtom() {
    const token = tokens[i++]
    if (token === '(') {
      const value = parseOr()
      i++ // ')'
      return value
    }
    return token !== undefined && allowed.has(token)
  }
  const result = parseOr()
  return result && i >= tokens.length
}

/**
 * @typedef {{ name: string, versions: string[], license: string }} LicensedPackage
 * @typedef {Record<string, LicensedPackage[]>} LicenseReport
 * @typedef {{ name: string, version: string, license: string, scope: 'prod' | 'dev' }} Violation
 */

/**
 * @param {LicenseReport} report
 * @param {Set<string>} allowed
 * @param {Record<string, string>} exceptions
 * @param {'prod' | 'dev'} scope
 * @returns {Violation[]}
 */
export function findViolations(report, allowed, exceptions, scope) {
  /** @type {Violation[]} */
  const violations = []
  for (const packages of Object.values(report)) {
    for (const pkg of packages) {
      if (isExpressionAllowed(pkg.license, allowed)) continue
      for (const version of pkg.versions) {
        if (exceptions[`${pkg.name}@${version}`]) continue
        violations.push({ name: pkg.name, version, license: pkg.license, scope })
      }
    }
  }
  return violations
}

/**
 * 解析 `pnpm licenses list --json` 的输出。没有依赖时 pnpm 输出一行提示文字而不是 JSON。
 * @param {string} output
 * @returns {LicenseReport}
 */
export function parseLicenseOutput(output) {
  return output.trim().startsWith('{') ? JSON.parse(output) : {}
}

/**
 * 随应用分发的外部二进制（scripts/bundled-binaries.json）。
 * @typedef {{ name: string, version: string, license: string, author?: string, homepage?: string, licenseDir: string }} BundledBinary
 */

/**
 * 读取 scripts/bundled-binaries.json。
 * @param {string} root 仓库根目录
 * @returns {BundledBinary[]}
 */
export function loadBundledBinaries(root) {
  return JSON.parse(readFileSync(path.join(root, 'scripts/bundled-binaries.json'), 'utf8')).binaries
}

/**
 * 把外部二进制转为与 `pnpm licenses list` 相同的格式（许可证目录为绝对路径）。
 * @param {readonly BundledBinary[]} binaries
 * @param {string} root
 * @returns {Record<string, (LicensedPackage & { paths: string[], author?: string, homepage?: string })[]>}
 */
export function binariesReport(binaries, root) {
  return {
    'bundled binaries': binaries.map((b) => ({
      name: b.name,
      versions: [b.version],
      paths: [path.join(root, b.licenseDir)],
      license: b.license,
      ...(b.author ? { author: b.author } : {}),
      ...(b.homepage ? { homepage: b.homepage } : {}),
    })),
  }
}

/**
 * @typedef {object} CheckDeps
 * @property {(flag: '--prod' | '--dev') => string} listLicenses 返回 pnpm licenses 的原始输出
 * @property {LicenseReport} [binaries] 随应用分发的外部二进制（见 binariesReport）
 * @property {Record<string, string>} exceptions
 * @property {(line: string) => void} log
 * @property {(line: string) => void} error
 */

/**
 * 执行检查，返回进程退出码。
 * @param {CheckDeps} deps
 * @returns {number}
 */
export function runLicenseCheck({ listLicenses, binaries = {}, exceptions, log, error }) {
  const devAllowed = new Set([...PERMISSIVE, ...DEV_ONLY])
  const violations = [
    ...findViolations(parseLicenseOutput(listLicenses('--prod')), PERMISSIVE, exceptions, 'prod'),
    ...findViolations(binaries, PERMISSIVE, exceptions, 'prod'),
    ...findViolations(parseLicenseOutput(listLicenses('--dev')), devAllowed, exceptions, 'dev'),
  ]
  if (violations.length === 0) {
    log('License check passed.')
    return 0
  }
  error('License check failed (ADR-0014). Disallowed licenses:')
  for (const v of violations) error(`  [${v.scope}] ${v.name}@${v.version}: ${v.license}`)
  error('Replace the dependency, or register it in scripts/license-exceptions.json with a reason.')
  return 1
}

/* v8 ignore start -- 命令行入口：调用真实的 pnpm，逻辑已由 runLicenseCheck 覆盖 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  process.exitCode = runLicenseCheck({
    listLicenses: (flag) =>
      execFileSync('pnpm', ['licenses', 'list', flag, '--json'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }),
    binaries: binariesReport(loadBundledBinaries(root), root),
    exceptions: JSON.parse(readFileSync(path.join(root, 'scripts/license-exceptions.json'), 'utf8'))
      .exceptions,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}
/* v8 ignore stop */
