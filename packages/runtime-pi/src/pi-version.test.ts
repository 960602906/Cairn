/**
 * pi 版本锁定的守卫测试（S8，从 spikes/pi-contract/test/version.test.mjs 移入，改为读 pnpm 锁文件）：
 *
 * - 只有 runtime-pi 声明 pi 依赖，版本是精确版本（不带 `^` / `~`），各包相同，且等于 `PI_VERSION`；
 * - 锁文件中每个 pi 包（`@earendil-works/*`，集合随版本变化）只有一个版本、一份安装（同版本但 peer 依赖
 *   不同时 pnpm 也会装出两份）——pi-agent-core 精确依赖同版本的 pi-ai，两者不一致会装出两份 pi-ai；
 * - 实际安装的 pi 包与锁文件一致，pi-agent-core 加载的 pi-ai 就是 runtime-pi 直接依赖的那一份；
 * - pi 自身对所有依赖都用精确版本，锁文件之外没有浮动的版本。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PI_VERSION } from './index.js'

const pkgRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(pkgRoot, '../..')
const SCOPE = '@earendil-works/'
const EXACT = /^\d+\.\d+\.\d+$/

type Manifest = {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
const readJson = (file: string): Manifest => JSON.parse(readFileSync(file, 'utf8')) as Manifest
const piDeps = (m: Manifest) =>
  Object.entries({
    ...m.dependencies,
    ...m.devDependencies,
    ...m.optionalDependencies,
    ...m.peerDependencies,
  }).filter(([name]) => name.startsWith(SCOPE))

/**
 * 读出锁文件某一节（`packages:` 或 `snapshots:`）中 pi 包的条目。
 * 条目形如 `  '@earendil-works/pi-ai@1.5.0':` 或带 peer 后缀 `  '@earendil-works/pi-ai@1.5.0(zod@4.6.6)':`。
 */
function lockEntries(lock: string, section: 'packages' | 'snapshots') {
  const start = lock.indexOf(`\n${section}:\n`)
  expect(start, `锁文件缺少 ${section} 节`).toBeGreaterThan(0)
  const rest = lock.slice(start + section.length + 3)
  const end = rest.search(/\n\S/)
  const body = end < 0 ? rest : rest.slice(0, end)
  const entries: { name: string; version: string }[] = []
  for (const match of body.matchAll(/^ {2}'?(@earendil-works\/[^@'\s]+)@([^('\s:]+)/gm)) {
    entries.push({ name: match[1] as string, version: match[2] as string })
  }
  return entries
}

/**
 * 按 Node 的查找规则（从 `from` 逐级向上找 `node_modules/<name>`）定位包目录并取真实路径。
 * 在 pnpm 的符号链接布局下，从某个包的真实目录出发，找到的就是它实际加载的依赖。
 */
function packageDir(from: string, name: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
    if (path.dirname(dir) === dir) throw new Error(`${name} not found from ${from}`)
  }
}

/** 从 runtime-pi 的直接依赖出发，沿依赖关系找出实际安装的全部 pi 包（名称 → 真实目录）。 */
function installedPi(): Map<string, string> {
  const found = new Map<string, string>()
  const visit = (from: string, name: string) => {
    const dir = packageDir(from, name)
    const seen = found.get(name)
    if (seen !== undefined) {
      expect(dir, `${name} 装了不止一份`).toBe(seen)
      return
    }
    found.set(name, dir)
    for (const [dep] of piDeps(readJson(path.join(dir, 'package.json')))) visit(dir, dep)
  }
  for (const [name] of piDeps(manifest)) visit(pkgRoot, name)
  return found
}

const manifest = readJson(path.join(pkgRoot, 'package.json'))
const lock = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8')

describe('pi 版本锁定', () => {
  const declared = piDeps(manifest)

  it('声明为精确版本，各包相同，且等于 PI_VERSION', () => {
    expect(declared.map(([name]) => name).sort()).toEqual([
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
    ])
    for (const [name, v] of declared) expect(v, name).toBe(PI_VERSION)
    expect(PI_VERSION).toMatch(EXACT)
  })

  it('其他工作区包不声明 pi 依赖（ADR-0004）', () => {
    const others = ['packages', 'apps']
      .flatMap((group) =>
        readdirSync(path.join(repoRoot, group)).map((dir) => path.join(repoRoot, group, dir)),
      )
      .filter((dir) => dir !== pkgRoot && existsSync(path.join(dir, 'package.json')))
    expect(others.length).toBeGreaterThan(0)
    for (const dir of others) {
      const m = readJson(path.join(dir, 'package.json'))
      expect(piDeps(m), m.name).toEqual([])
    }
  })

  it('锁文件中每个 pi 包只有一个版本、一份安装，与声明一致', () => {
    const packages = lockEntries(lock, 'packages')
    const snapshots = lockEntries(lock, 'snapshots')
    for (const [name] of declared)
      expect(
        packages.some((e) => e.name === name),
        name,
      ).toBe(true)
    for (const e of packages) expect(e.version, e.name).toBe(PI_VERSION)
    const names = packages.map((e) => e.name)
    expect(new Set(names).size, '同一 pi 包有多个版本').toBe(names.length)
    const snapshotNames = snapshots.map((e) => e.name)
    expect(snapshotNames.sort(), '同一 pi 包有多份安装（peer 依赖不同）').toEqual([...names].sort())
  })

  it('实际安装的 pi 包与锁文件一致', () => {
    const installed = installedPi()
    const locked = lockEntries(lock, 'packages').map((e) => e.name)
    expect([...installed.keys()].sort()).toEqual(locked.sort())
    for (const [name, dir] of installed) {
      expect(readJson(path.join(dir, 'package.json')).version, name).toBe(PI_VERSION)
    }
  })

  it('pi-agent-core 加载的 pi-ai 与直接依赖是同一份', () => {
    const direct = packageDir(pkgRoot, '@earendil-works/pi-ai')
    const viaCore = packageDir(
      packageDir(pkgRoot, '@earendil-works/pi-agent-core'),
      '@earendil-works/pi-ai',
    )
    expect(viaCore).toBe(direct)
  })

  it('pi 各包的依赖都是精确版本', () => {
    for (const [name, dir] of installedPi()) {
      const pkg = readJson(path.join(dir, 'package.json'))
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        expect(range, `${name} → ${dep}`).toMatch(EXACT)
      }
    }
  })
})

describe('pi 可加载', () => {
  it('pi-agent-core 与 pi-ai 的入口可以导入', async () => {
    const [core, ai] = await Promise.all([
      import('@earendil-works/pi-agent-core'),
      import('@earendil-works/pi-ai'),
    ])
    expect(typeof core.Agent).toBe('function')
    expect(typeof ai.createModels).toBe('function')
  })

  it('内置目录中有 DeepSeek V4.1 Flash（S2：DeepSeek 用内置模型定义）', async () => {
    const { DEEPSEEK_MODELS } = await import('@earendil-works/pi-ai/providers/deepseek.models')
    expect(Object.values(DEEPSEEK_MODELS).some((m) => m.id === 'deepseek-flash')).toBe(true)
  })
})
