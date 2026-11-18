// @ts-check
/**
 * 三平台发布产物汇总（M6-07）。
 *
 * `release-artifacts.mjs` 在 Windows、macOS、Linux 的构建 job 中各自产出一个目录；本脚本把
 * 它们合并成一次发布所需的单一目录：
 * - 安装包、更新元数据（`latest*.yml` / `beta*.yml`）与 blockmap 原样保留；
 * - `THIRD_PARTY_NOTICES.txt` 与 `dependencies.json` 按平台改名，避免互相覆盖；
 * - 生成一份合并的 `release-notes.md`、`provenance.json` 与 `SHA256SUMS`。
 *
 * 版本、通道、提交必须一致；同名产物内容不同即失败关闭。
 *
 * 汇总 job 检出标签后直接运行本脚本、不安装工作区依赖，因此这里只能依赖 node 内建模块与
 * `release-files.mjs`；不要引入 `@cairn/*` 或其他需要 `pnpm install` 才能解析的包。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PLATFORM_NOTES_SCHEMA_VERSION,
  readJson,
  sha256,
  writeChecksums,
} from './release-files.mjs'

export const MERGED_FILES = new Set([
  'release-notes.md',
  'provenance.json',
  'SHA256SUMS',
  'platform-notes.json',
])
const PLATFORM_ORDER = ['windows', 'mac', 'linux']

/**
 * @typedef {{
 *   platform: string;
 *   label: string;
 *   version: string;
 *   channel: string;
 *   commit: string;
 *   buildTime: string;
 *   signing: Record<string, unknown>;
 *   metadata: string;
 *   support: string[];
 *   install: string[];
 *   knownIssues: string[];
 *   changelogSection: string;
 *   downloads: { name: string; sha256: string; size: number }[];
 * }} PlatformNotes
 */

/**
 * @param {string} directory
 * @returns {PlatformNotes}
 */
export function readPlatformNotes(directory) {
  const file = path.join(directory, 'platform-notes.json')
  if (!existsSync(file)) throw new Error(`platform notes are missing: ${file}`)
  const notes = readJson(file)
  if (notes['schemaVersion'] !== PLATFORM_NOTES_SCHEMA_VERSION) {
    throw new Error(`unsupported platform notes schema in ${file}`)
  }
  if (!PLATFORM_ORDER.includes(String(notes['platform']))) {
    throw new Error(`unknown platform in ${file}: ${String(notes['platform'])}`)
  }
  return /** @type {PlatformNotes} */ (notes)
}

/**
 * @param {string} platform
 * @param {Record<string, unknown>} signing
 * @returns {string}
 */
export function signingSummaryLine(platform, signing) {
  if (platform === 'linux') return '未签名（SHA-256 校验和与 HTTPS 更新源）'
  if (signing['mode'] === 'none') return 'unsigned beta'
  if (platform === 'mac') return `已签名（${String(signing['mode'])}）并公证`
  return `已签名（${String(signing['mode'])}）`
}

/**
 * @param {{
 *   version: string;
 *   channel: 'stable' | 'beta';
 *   commit: string;
 *   platforms: readonly PlatformNotes[];
 * }} input
 * @returns {string}
 */
export function renderCombinedReleaseNotes({ version, channel, commit, platforms }) {
  const ordered = [...platforms].sort(
    (left, right) =>
      PLATFORM_ORDER.indexOf(String(left['platform'])) -
      PLATFORM_ORDER.indexOf(String(right['platform'])),
  )
  const changelog = String(ordered[0]?.['changelogSection'] ?? '')
  /**
   * @param {string} heading
   * @param {string} body
   * @returns {string[]}
   */
  const section = (heading, body) => [`## ${heading}`, '', body, '']
  return [
    `# Cairn ${version} 发布说明`,
    '',
    '## 版本与通道',
    '',
    `- 版本：\`${version}\``,
    `- 通道：\`${channel}\``,
    `- 构建提交：\`${commit}\``,
    `- 支持平台：${ordered.map((notes) => String(notes['label'])).join('、')}`,
    '',
    '## 本次变化',
    '',
    changelog,
    '',
    ...section(
      '平台与签名状态',
      ordered
        .map(
          (notes) =>
            `- ${String(notes['label'])}：${signingSummaryLine(String(notes['platform']), notes['signing'])}`,
        )
        .join('\n'),
    ),
    ...section(
      '下载与校验',
      ordered
        .flatMap((notes) => [
          `### ${String(notes['label'])}`,
          '',
          ...(notes['downloads'] ?? []).flatMap((file) => [
            `- 安装包：\`${String(file['name'])}\``,
            `- SHA-256：\`${String(file['sha256'])}\``,
          ]),
          `- 更新元数据：\`${String(notes['metadata'])}\``,
          '',
        ])
        .join('\n'),
    ),
    ...section(
      '安装',
      ordered
        .flatMap((notes) => [
          `### ${String(notes['label'])}`,
          '',
          ...(notes['install'] ?? []).map((line) => `- ${String(line)}`),
          '',
        ])
        .join('\n'),
    ),
    ...section(
      '已知问题',
      ordered
        .flatMap((notes) => [
          `### ${String(notes['label'])}`,
          '',
          ...(notes['knownIssues'] ?? []).map((line) => `- ${String(line)}`),
          '',
        ])
        .join('\n'),
    ),
    ...section(
      '验证范围',
      [
        '- 单元、集成与覆盖率门禁：`pnpm test:coverage`（三个平台）',
        '- 构建、冒烟与打包校验：`pnpm build`、`pnpm smoke`、`pnpm package:verify`',
        '- 端到端：`pnpm e2e`（Windows 与 Linux）',
        '- 自动更新：各平台的 `latest*.yml` / `beta*.yml` 校验',
        '- 第三方声明与 GPL 源码获取方式：安装目录 `THIRD_PARTY_NOTICES-<platform>.txt`、应用内关于页',
      ].join('\n'),
    ),
  ].join('\n')
}

/**
 * @param {{
 *   version: string;
 *   channel: 'stable' | 'beta';
 *   commit: string;
 *   platforms: readonly PlatformNotes[];
 *   artifacts: readonly { name: string; sha256: string; size: number }[];
 *   env: Readonly<Record<string, string | undefined>>;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function renderCombinedProvenance({ version, channel, commit, platforms, artifacts, env }) {
  return {
    schemaVersion: PLATFORM_NOTES_SCHEMA_VERSION,
    version,
    channel,
    commit,
    repository: env['GITHUB_REPOSITORY'] ?? 'local',
    workflow: env['GITHUB_WORKFLOW_REF'] ?? 'local',
    runId: env['GITHUB_RUN_ID'] ?? '',
    runAttempt: env['GITHUB_RUN_ATTEMPT'] ?? '',
    serverUrl: env['GITHUB_SERVER_URL'] ?? '',
    platforms: platforms.map((notes) => ({
      platform: notes['platform'],
      label: notes['label'],
      buildTime: notes['buildTime'],
      signing: notes['signing'],
      metadata: notes['metadata'],
      downloads: notes['downloads'],
    })),
    artifacts,
  }
}

/**
 * @param {{
 *   dirs: readonly string[];
 *   outDir: string;
 *   env?: Readonly<Record<string, string | undefined>>;
 * }} options
 * @returns {{
 *   outDir: string;
 *   files: string[];
 *   releaseNotes: string;
 *   platforms: PlatformNotes[];
 * }}
 */
export function mergeReleases({ dirs, outDir, env = process.env }) {
  if (dirs.length === 0) throw new Error('at least one platform release directory is required')
  const platforms = dirs.map(readPlatformNotes)
  const seen = new Set()
  for (const notes of platforms) {
    const platform = String(notes['platform'])
    if (seen.has(platform)) throw new Error(`duplicate release platform: ${platform}`)
    seen.add(platform)
  }
  const [first] = platforms
  if (first === undefined) throw new Error('at least one platform release directory is required')
  const firstRecord = /** @type {Record<string, unknown>} */ (first)
  for (const notes of platforms) {
    const record = /** @type {Record<string, unknown>} */ (notes)
    for (const field of ['version', 'channel', 'commit', 'changelogSection']) {
      if (record[field] !== firstRecord[field]) {
        throw new Error(
          `${String(notes['platform'])} release ${field} does not match ${String(first['platform'])}`,
        )
      }
    }
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const [index, notes] of platforms.entries()) {
    const directory = dirs[index]
    if (directory === undefined) continue
    const platform = String(notes['platform'])
    for (const name of readdirSync(directory).sort()) {
      if (MERGED_FILES.has(name)) continue
      const source = path.join(directory, name)
      if (!statSync(source).isFile()) continue
      const targetName =
        name === 'THIRD_PARTY_NOTICES.txt'
          ? `THIRD_PARTY_NOTICES-${platform}.txt`
          : name === 'dependencies.json'
            ? `dependencies-${platform}.json`
            : name
      const target = path.join(outDir, targetName)
      if (existsSync(target)) {
        if (!readFileSync(target).equals(readFileSync(source))) {
          throw new Error(`conflicting release artifact: ${targetName} (${platform})`)
        }
        continue
      }
      writeFileSync(target, readFileSync(source))
    }
  }

  const version = String(first['version'])
  const channel = /** @type {'stable' | 'beta'} */ (first['channel'])
  const commit = String(first['commit'])
  const releaseNotes = renderCombinedReleaseNotes({ version, channel, commit, platforms })
  writeFileSync(path.join(outDir, 'release-notes.md'), releaseNotes)

  const artifactNames = readdirSync(outDir)
    .filter((name) => name !== 'SHA256SUMS' && name !== 'provenance.json')
    .sort()
  const artifacts = artifactNames.map((name) => {
    const file = path.join(outDir, name)
    return { name, sha256: sha256(file), size: statSync(file).size }
  })
  writeFileSync(
    path.join(outDir, 'provenance.json'),
    `${JSON.stringify(
      renderCombinedProvenance({ version, channel, commit, platforms, artifacts, env }),
      null,
      2,
    )}\n`,
  )
  writeChecksums({
    directory: outDir,
    files: readdirSync(outDir).filter((name) => name !== 'SHA256SUMS'),
  })
  return { outDir, files: readdirSync(outDir).sort(), releaseNotes, platforms }
}

/**
 * 在根目录下查找包含 `platform-notes.json` 的直接子目录。
 * @param {string} root
 * @returns {string[]}
 */
export function platformDirectories(root) {
  if (!existsSync(root)) throw new Error(`release root does not exist: ${root}`)
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((directory) => existsSync(path.join(directory, 'platform-notes.json')))
    .sort()
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   env?: Readonly<Record<string, string | undefined>>;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  /** @param {string} flag */
  const values = (flag) => {
    const result = []
    for (let index = 0; index < argv.length; index += 1) {
      const next = argv[index + 1]
      if (argv[index] === flag && next !== undefined) result.push(next)
    }
    return result
  }
  const root = values('--root')[0]
  const outDir = values('--out')[0]
  const dirs = values('--dir')
  try {
    const inputDirs = dirs.length > 0 ? dirs : root === undefined ? [] : platformDirectories(root)
    if (inputDirs.length === 0) {
      error('usage: merge-release.mjs --root <dir> [--out <dir>] | --dir <platform-dir> ...')
      return 1
    }
    const output = outDir ?? path.join(root ?? path.dirname(inputDirs[0] ?? '.'), 'merged')
    const result = mergeReleases({ dirs: inputDirs, outDir: output, env })
    log(`release: merged ${result.platforms.length} platforms into ${result.outDir}`)
    log(`release: ${result.files.length} files`)
    return 0
  } catch (failure) {
    error(`release: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

/* v8 ignore start -- CLI bootstrap is executed by the release workflow, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
/* v8 ignore stop */
