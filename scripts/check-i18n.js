// @ts-check
/**
 * i18n key 一致性检查（ADR-0013，M0-11b）。
 *
 * `packages/i18n/locales/<语言>/<命名空间>.json`：
 * - 每种语言的命名空间文件集合必须相同；
 * - 同一命名空间在各语言中的 key 必须完全一致；
 * - 值必须是非空字符串（key 为扁平的点分字符串，不允许嵌套对象）。
 *
 * 用法：node scripts/check-i18n.js
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {Record<string, Record<string, unknown>>} LocaleResources 命名空间 → 文案 */

/**
 * @typedef {object} I18nProblem
 * @property {string} locale
 * @property {string} [namespace]
 * @property {string} [key]
 * @property {'missing_namespace' | 'missing_key' | 'invalid_value'} kind
 */

/**
 * 比较各语言的资源，返回问题列表（为空表示一致）。以所有语言的并集为准，缺哪个报哪个。
 * @param {Record<string, LocaleResources>} resources 语言 → 命名空间 → 文案
 * @returns {I18nProblem[]}
 */
export function compareLocales(resources) {
  /** @type {I18nProblem[]} */
  const problems = []
  const locales = Object.keys(resources).sort()
  const namespaces = [...new Set(locales.flatMap((l) => Object.keys(resources[l] ?? {})))].sort()

  for (const namespace of namespaces) {
    const keys = [
      ...new Set(locales.flatMap((l) => Object.keys(resources[l]?.[namespace] ?? {}))),
    ].sort()
    for (const locale of locales) {
      const messages = resources[locale]?.[namespace]
      if (!messages) {
        problems.push({ locale, namespace, kind: 'missing_namespace' })
        continue
      }
      for (const key of keys) {
        if (!(key in messages)) {
          problems.push({ locale, namespace, key, kind: 'missing_key' })
          continue
        }
        const value = messages[key]
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push({ locale, namespace, key, kind: 'invalid_value' })
        }
      }
    }
  }
  return problems
}

/**
 * 读取 locales 目录。
 * @param {string} dir
 * @returns {Record<string, LocaleResources>}
 */
export function loadLocales(dir) {
  /** @type {Record<string, LocaleResources>} */
  const resources = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    /** @type {LocaleResources} */
    const namespaces = {}
    for (const file of readdirSync(path.join(dir, entry.name))) {
      if (!file.endsWith('.json')) continue
      namespaces[file.slice(0, -'.json'.length)] = JSON.parse(
        readFileSync(path.join(dir, entry.name, file), 'utf8'),
      )
    }
    resources[entry.name] = namespaces
  }
  return resources
}

/**
 * @param {I18nProblem} p
 * @returns {string}
 */
function describe(p) {
  const where = `${p.locale}/${p.namespace}.json`
  switch (p.kind) {
    case 'missing_namespace':
      return `${where}: file is missing`
    case 'missing_key':
      return `${where}: missing key "${p.key}"`
    case 'invalid_value':
      return `${where}: "${p.key}" must be a non-empty string`
  }
}

/**
 * 执行检查，返回进程退出码。
 * @param {{ resources: Record<string, LocaleResources>, log: (line: string) => void, error: (line: string) => void }} deps
 * @returns {number}
 */
export function runI18nCheck({ resources, log, error }) {
  const locales = Object.keys(resources)
  if (locales.length < 2) {
    error(`i18n check failed: expected at least 2 locales, found ${locales.length}.`)
    return 1
  }
  const problems = compareLocales(resources)
  if (problems.length === 0) {
    log(`i18n check passed (${locales.sort().join(', ')}).`)
    return 0
  }
  error('i18n check failed (ADR-0013): locales must have the same keys.')
  for (const p of problems) error(`  ${describe(p)}`)
  return 1
}

/* v8 ignore start -- 命令行入口：读取真实目录，逻辑已由 runI18nCheck 覆盖 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  process.exitCode = runI18nCheck({
    resources: loadLocales(path.join(root, 'packages/i18n/locales')),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}
/* v8 ignore stop */
