// @ts-check
/**
 * 构建信息（M5-01）：把版本、通道、提交、构建时间与工具链版本写入
 * `apps/desktop/out/build-info.json`，由主进程经 `app.info` 提供给界面与诊断包。
 *
 * 文件只包含构建元数据，不包含工作目录、用户路径、凭据或项目内容。数据库 schema 版本在运行时由
 * `@cairn/storage` 的迁移列表给出，不写死在构建产物里。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readVersion } from './sync-version.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/** 构建信息文件的格式版本。 */
export const BUILD_INFO_SCHEMA_VERSION = 1

/**
 * 解析更新通道：显式 `stable` / `beta` 优先，否则 0.x 视为 beta，1.0 起视为 stable。
 * @param {string | undefined} raw
 * @param {string} version
 * @returns {'stable' | 'beta'}
 */
export function resolveChannel(raw, version) {
  if (raw === 'stable' || raw === 'beta') return raw
  return version.startsWith('0.') ? 'beta' : 'stable'
}

/**
 * 读取构建提交：优先 CI 提供的 `GITHUB_SHA`，其次 `git rev-parse`；都不可用时返回 `unknown`。
 * @param {string} cwd
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string}
 */
export function readGitCommit(cwd, env = process.env) {
  const fromCi = env['GITHUB_SHA']?.trim()
  if (fromCi && /^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 读取构建时使用的 Electron 版本；读取失败时返回空串（运行时仍会提供真实版本）。
 * @param {string} root
 * @returns {string}
 */
export function readElectronVersion(root) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'apps/desktop/node_modules/electron/package.json'), 'utf8'),
    )
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/**
 * 组装构建信息。纯函数，便于测试。
 * @param {{
 *   root: string;
 *   channel?: string | undefined;
 *   commit: string;
 *   now: Date;
 *   electronVersion: string;
 *   nodeVersion: string;
 * }} input
 */
export function collectBuildInfo({ root, channel, commit, now, electronVersion, nodeVersion }) {
  const version = readVersion(path.join(root, 'package.json'))
  return {
    schemaVersion: BUILD_INFO_SCHEMA_VERSION,
    version,
    channel: resolveChannel(channel, version),
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : 'unknown',
    buildTime: now.toISOString(),
    electronVersion: electronVersion.trim(),
    nodeVersion: nodeVersion.trim().replace(/^v/, ''),
  }
}

/**
 * 生成并写入构建信息；根包与桌面包版本不一致时拒绝构建。
 * @param {{
 *   root?: string;
 *   outDir?: string;
 *   env?: Readonly<Record<string, string | undefined>>;
 *   now?: Date;
 * }} [options]
 */
export function writeBuildInfo({
  root = REPO_ROOT,
  outDir = path.join(root, 'apps/desktop/out'),
  env = process.env,
  now = new Date(),
} = {}) {
  const rootVersion = readVersion(path.join(root, 'package.json'))
  const appVersion = readVersion(path.join(root, 'apps/desktop/package.json'))
  if (rootVersion !== appVersion) {
    throw new Error(
      `version mismatch: root package.json is ${rootVersion}, apps/desktop/package.json is ` +
        `${appVersion}. Run \`pnpm sync:version\` before building.`,
    )
  }
  const info = collectBuildInfo({
    root,
    channel: env['CAIRN_CHANNEL'],
    commit: readGitCommit(root, env),
    now,
    electronVersion: readElectronVersion(root),
    nodeVersion: process.version,
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
  return info
}

/**
 * 命令行入口。
 * @param {{
 *   root?: string;
 *   env?: Readonly<Record<string, string | undefined>>;
 *   now?: Date;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  root = REPO_ROOT,
  env = process.env,
  now = new Date(),
  log = (line) => console.log(line),
} = {}) {
  const info = writeBuildInfo({ root, env, now })
  log(`build-info: ${info.version} ${info.channel} ${info.commit.slice(0, 7)}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
