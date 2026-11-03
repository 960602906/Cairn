// @ts-check
/**
 * 版本锁定的守卫测试（M1 移到 `packages/runtime-pi`）：
 *
 * - `package.json` 中 pi 的版本是精确版本（不带 `^` / `~`），且各包相同；
 * - 锁文件中每个 pi 包（`@earendil-works/*`，集合随版本变化）只有一份，版本与声明一致——
 *   pi-agent-core 精确依赖同版本的 pi-ai，两者不一致会装出两份 pi-ai；
 * - 安装的版本与锁文件一致；
 * - pi 自身对所有依赖都用精确版本，锁文件之外没有浮动的版本。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installedPiVersions } from '../src/cassette.mjs'

const root = path.resolve(import.meta.dirname, '..')
const readJson = (/** @type {string} */ file) => JSON.parse(readFileSync(file, 'utf8'))
const manifest = readJson(path.join(root, 'package.json'))
const lock = readJson(path.join(root, 'package-lock.json'))
const EXACT = /^\d+\.\d+\.\d+$/
const SCOPE = '@earendil-works/'

/** 锁文件中所有 pi 包及其版本（含嵌套安装）。 */
const locked = (() => {
  /** @type {Map<string, Set<string>>} */
  const packages = new Map()
  for (const [key, entry] of Object.entries(lock.packages)) {
    const match = /(?:^|\/)node_modules\/(@earendil-works\/[^/]+)$/.exec(key)
    if (!match?.[1]) continue
    const versions = packages.get(match[1]) ?? new Set()
    versions.add(/** @type {any} */ (entry).version)
    packages.set(match[1], versions)
  }
  return packages
})()

/**
 * 按 Node 的查找规则（从 `from` 逐级向上找 `node_modules/<name>`）定位包目录并取真实路径。
 * pnpm 的符号链接布局下同样适用：从 pi-agent-core 的真实目录出发，找到的是它实际加载的 pi-ai。
 */
function packageDir(/** @type {string} */ from, /** @type {string} */ name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
    if (path.dirname(dir) === dir) throw new Error(`${name} not found from ${from}`)
  }
}

describe('pi 版本锁定', () => {
  const declared = Object.entries(manifest.dependencies).filter(([name]) => name.startsWith(SCOPE))
  const version = declared[0]?.[1]

  it('声明为精确版本，且各包版本相同', () => {
    expect(declared.length).toBeGreaterThan(0)
    for (const [name, v] of declared) expect(v, name).toMatch(EXACT)
    expect(new Set(declared.map(([, v]) => v)).size).toBe(1)
  })

  it('锁文件中每个 pi 包只有一个版本，与声明一致', () => {
    for (const [name] of declared) expect(locked.has(name), name).toBe(true)
    for (const [name, versions] of locked) expect([...versions], name).toEqual([version])
  })

  it('安装的版本与锁文件一致', () => {
    const installed = installedPiVersions()
    expect(Object.keys(installed).sort()).toEqual([...locked.keys()].sort())
    for (const [name, v] of Object.entries(installed))
      expect(locked.get(name)?.has(v), name).toBe(true)
  })

  it('pi-agent-core 解析到的 pi-ai 与直接依赖是同一份', () => {
    const direct = packageDir(root, '@earendil-works/pi-ai')
    const viaCore = packageDir(
      packageDir(root, '@earendil-works/pi-agent-core'),
      '@earendil-works/pi-ai',
    )
    expect(viaCore).toBe(direct)
  })

  it('pi 各包的依赖都是精确版本', () => {
    for (const name of locked.keys()) {
      const pkg = readJson(path.join(root, 'node_modules', name, 'package.json'))
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        expect(range, `${name} → ${dep}`).toMatch(EXACT)
      }
    }
  })
})
