// @ts-check
/**
 * 发布产物整理（M5-08 / M6-07）：把 electron-builder 的输出变成可上传、可校验、可追溯的一组文件。
 *
 * 每个平台单独整理（M6-07 的三平台发布流水线），产物目录包含：
 * - 该平台的安装包与 blockmap；
 * - 该平台的更新元数据：Windows `latest.yml`/`beta.yml`，macOS `latest-mac.yml`/`beta-mac.yml`，
 *   Linux `latest-linux.yml`/`beta-linux.yml`；
 * - `SHA256SUMS`（对目录内除自身外的全部文件）；
 * - `THIRD_PARTY_NOTICES.txt`、`dependencies.json`；
 * - `release-notes.md`（从 CHANGELOG 抽取本节，附平台签名状态）；
 * - `platform-notes.json`（供 `merge-release.mjs` 汇总三平台发布说明）；
 * - `provenance.json`（提交、工作流、工具链、签名摘要与每个产物的 SHA-256）。
 *
 * 任何字段不一致（版本、通道、安装包名、哈希）都失败关闭，避免把错误元数据发布到更新源。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
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
  macSignatureSummary,
  readMacSigningConfig,
  readSigningConfig,
  signatureSummary,
} from '@cairn/release-tools'

export const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..', 'apps/desktop')
export const PRODUCT_NAME = 'Cairn'
export const PROVENANCE_SCHEMA_VERSION = 1
export const PLATFORM_NOTES_SCHEMA_VERSION = 1
export const RELEASE_PLATFORMS = ['windows', 'mac', 'linux']

/**
 * @typedef {{
 *   label: string;
 *   artifacts: (version: string) => string[];
 *   updatable: (version: string) => string[];
 *   blockmaps: (version: string) => string[];
 *   builderMetadata: string;
 *   metadataName: (channel: 'stable' | 'beta') => string;
 *   support: readonly string[];
 *   install: readonly string[];
 *   knownIssues: readonly string[];
 * }} PlatformSpec
 */

/** @type {Record<string, PlatformSpec>} */
const PLATFORM_SPECS = {
  windows: {
    label: 'Windows x64',
    artifacts: (version) => [`Cairn-${version}-x64-setup.exe`],
    updatable: (version) => [`Cairn-${version}-x64-setup.exe`],
    blockmaps: (version) => [`Cairn-${version}-x64-setup.exe.blockmap`],
    builderMetadata: 'latest.yml',
    metadataName: (channel) => (channel === 'stable' ? 'latest.yml' : 'beta.yml'),
    support: [
      'Windows 11（至少 24H2，正式支持）；Windows 10 22H2（best-effort）',
      'Windows x64、NSIS、按用户安装、无需管理员',
    ],
    install: [
      '下载安装包并运行；安装器会创建桌面与开始菜单快捷方式。',
      '卸载后用户数据默认保留；需要彻底清理时删除 `%APPDATA%\\Cairn`。',
    ],
    knownIssues: [
      '沙箱默认档位限制工作区外写入与管理员权限，但网络尚未隔离；需要联网的命令按审批执行。',
      '自动更新不做二进制降级；数据库版本过新时拒绝启动。',
      'Windows 10 22H2 已结束微软支持，仅尽力兼容。',
    ],
  },
  mac: {
    label: 'macOS（arm64 + x64）',
    artifacts: (version) =>
      ['arm64', 'x64'].flatMap((arch) => [
        `Cairn-${version}-${arch}.dmg`,
        `Cairn-${version}-${arch}.zip`,
      ]),
    updatable: (version) => ['arm64', 'x64'].map((arch) => `Cairn-${version}-${arch}.zip`),
    blockmaps: (version) => ['arm64', 'x64'].map((arch) => `Cairn-${version}-${arch}.zip.blockmap`),
    builderMetadata: 'latest-mac.yml',
    metadataName: (channel) => (channel === 'stable' ? 'latest-mac.yml' : 'beta-mac.yml'),
    support: [
      'macOS 13 Ventura 及以上（Apple Silicon 与 Intel 分架构构建）',
      'macOS arm64 / x64、DMG 安装、ZIP 用于自动更新',
    ],
    install: [
      '打开 DMG，把 Cairn 拖入“应用程序”；首次启动如被 Gatekeeper 阻止，请在“系统设置 → 隐私与安全性”中放行。',
      '卸载时退出 Cairn 并把 `Cairn.app` 移到废纸篓；用户数据默认保留在 `~/Library/Application Support/Cairn`。',
    ],
    knownIssues: [
      '未签名构建会被 Gatekeeper 阻止，不得宣称“已验证发布者”。',
      '命令沙箱尚未在 macOS 实现；命令按权限规则在沙箱外运行并标注“未沙箱化”。',
    ],
  },
  linux: {
    label: 'Linux x64',
    artifacts: (version) => [`Cairn-${version}-x64.AppImage`, `Cairn-${version}-x64.deb`],
    updatable: (version) => [`Cairn-${version}-x64.AppImage`],
    blockmaps: () => [],
    builderMetadata: 'latest-linux.yml',
    metadataName: (channel) => (channel === 'stable' ? 'latest-linux.yml' : 'beta-linux.yml'),
    support: [
      'Ubuntu LTS x64 为基线；其他发行版 best-effort',
      'AppImage（免安装、可自动更新）与 deb（系统安装、由包管理器升级）',
    ],
    install: [
      'AppImage：`chmod +x Cairn-<version>-x64.AppImage && ./Cairn-<version>-x64.AppImage`。',
      'deb：`sudo apt install ./Cairn-<version>-x64.deb`；卸载使用 `sudo apt remove cairn`。',
    ],
    knownIssues: [
      'Linux 没有统一代码签名；完整性由 SHA-256 校验和与 HTTPS 更新源保证。',
      '缺少用户命名空间时 AppImage 可能只能以 `--no-sandbox` 启动；这与 Cairn 命令沙箱无关，命令仍标注“未沙箱化”。',
      'deb 不自动更新，由系统包管理器升级；AppImage 通过 `electron-updater` 更新。',
    ],
  },
}

/**
 * @param {string} platform
 * @returns {PlatformSpec}
 */
export function platformSpec(platform) {
  const spec = PLATFORM_SPECS[platform]
  if (spec === undefined) {
    throw new Error(`unsupported release platform: ${platform}`)
  }
  return spec
}

/**
 * 每个平台的签名摘要：Windows Authenticode、macOS Developer ID、Linux 无签名。
 * @param {string} platform
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Record<string, unknown>}
 */
export function platformSigningSummary(platform, env = process.env) {
  if (platform === 'windows') return signatureSummary(readSigningConfig(env))
  if (platform === 'mac') return macSignatureSummary(readMacSigningConfig(env))
  return { mode: 'none', integrity: 'sha256+https' }
}

/**
 * @param {string} file
 * @returns {string}
 */
export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 读取 JSON 对象；不是对象时抛出。
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function readJson(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return parsed
}

/**
 * 从 CHANGELOG 中抽取指定版本的正文；找不到或正文为空时抛错。
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 标题行只允许行内空白：`\s` 会跨行吞掉空行与正文，导致 section 变空。
  const heading = new RegExp(`^## \\[${escaped}\\](?:[ \\t]+-[ \\t]+[^\\n]*)?[ \\t]*$`, 'm')
  const match = heading.exec(changelog)
  if (match === null) throw new Error(`CHANGELOG.md has no section for ${version}`)
  const start = match.index + match[0].length
  const rest = changelog.slice(start)
  const next = /^## \[/m.exec(rest)
  const section = (next === null ? rest : rest.slice(0, next.index)).trim()
  if (section === '') throw new Error(`CHANGELOG.md section for ${version} is empty`)
  return section
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function yamlString(name, value) {
  return `${name}: ${JSON.stringify(value)}`
}

/**
 * 生成 electron-updater generic provider 的更新元数据。
 * @param {{
 *   version: string;
 *   installer: string;
 *   sha512: string;
 *   size: number;
 *   releaseDate: string;
 * }} input
 * @returns {string}
 */
export function renderUpdateMetadata({ version, installer, sha512, size, releaseDate }) {
  return [
    yamlString('version', version),
    'files:',
    `  - ${yamlString('url', installer)}`,
    `    ${yamlString('sha512', sha512)}`,
    `    size: ${size}`,
    yamlString('path', installer),
    yamlString('sha512', sha512),
    yamlString('releaseDate', releaseDate),
    '',
  ].join('\n')
}

/**
 * 生成多文件更新元数据（macOS 的 arm64/x64 ZIP、Linux 的 AppImage）。第一个文件是
 * electron-builder 的 `path` 主产物；格式与 electron-updater 的 generic provider 一致。
 * @param {{
 *   version: string;
 *   files: readonly { name: string; sha512: string; size: number }[];
 *   releaseDate: string;
 * }} input
 * @returns {string}
 */
export function renderUpdateMetadataFiles({ version, files, releaseDate }) {
  const [primary] = files
  if (primary === undefined) throw new Error('update metadata needs at least one file')
  return [
    yamlString('version', version),
    'files:',
    ...files.flatMap((file) => [
      `  - ${yamlString('url', file.name)}`,
      `    ${yamlString('sha512', file.sha512)}`,
      `    size: ${file.size}`,
    ]),
    yamlString('path', primary.name),
    yamlString('sha512', primary.sha512),
    yamlString('releaseDate', releaseDate),
    '',
  ].join('\n')
}

/**
 * 解析 electron-builder 写出的更新元数据。
 * @param {string} metadata
 * @returns {{
 *   version: string | undefined;
 *   path: string | undefined;
 *   sha512: string | undefined;
 *   files: { url: string; sha512: string; size: number }[];
 * }}
 */
export function parseUpdateMetadata(metadata) {
  /** @param {string} name */
  const topLevel = (name) => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(metadata)
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  }
  /** @type {{ url: string; sha512: string; size: number }[]} */
  const files = []
  for (const block of metadata.split(/^\s*-\s+url:/m).slice(1)) {
    const url =
      /^\s*(.+)$/m
        .exec(block)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '') ?? ''
    const sha512 =
      /^\s+sha512:\s*(.+)$/m
        .exec(block)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '') ?? ''
    const size = Number(/^\s+size:\s*(\d+)$/m.exec(block)?.[1] ?? '')
    files.push({ url, sha512, size })
  }
  return { version: topLevel('version'), path: topLevel('path'), sha512: topLevel('sha512'), files }
}

/**
 * 校验更新元数据与产物一致；返回问题列表。
 *
 * electron-builder 26 会把同平台的全部产物写进元数据 `files`（macOS 同时列 dmg，
 * Linux 同时列 deb），但自动更新只使用 zip 与 AppImage。`allowedExtra` 列出这些
 * 已知的非更新载体，允许它们出现；`files` 中的文件仍逐个校验哈希与大小。
 *
 * @param {{
 *   metadata: string;
 *   version: string;
 *   files: readonly { name: string; sha512: string; size: number }[];
 *   allowedExtra?: readonly string[];
 * }} input
 * @returns {string[]}
 */
export function validateUpdateMetadataFiles({ metadata, version, files, allowedExtra = [] }) {
  const parsed = parseUpdateMetadata(metadata)
  const problems = []
  if (parsed.version !== version) problems.push('update metadata version does not match the build')
  const expected = new Map(files.map((file) => [file.name, file]))
  const extras = new Set(allowedExtra)
  const seen = new Set()
  for (const entry of parsed.files) {
    const file = expected.get(entry.url)
    if (file === undefined) {
      if (!extras.has(entry.url)) {
        problems.push(`update metadata references an unexpected file: ${entry.url}`)
      }
      continue
    }
    seen.add(entry.url)
    if (entry.sha512 !== file.sha512) {
      problems.push(`update metadata sha512 does not match ${file.name}`)
    }
    if (entry.size !== file.size) {
      problems.push(`update metadata size does not match ${file.name}`)
    }
  }
  for (const name of expected.keys()) {
    if (!seen.has(name)) problems.push(`update metadata does not reference ${name}`)
  }
  if (parsed.path === undefined || !expected.has(parsed.path)) {
    problems.push('update metadata path does not reference a built updatable file')
  } else if (parsed.sha512 !== expected.get(parsed.path)?.sha512) {
    problems.push('update metadata top-level sha512 does not match the primary file')
  }
  return problems
}

/**
 * 写入 `SHA256SUMS`（`<hex>  <file name>`），返回行数。
 * @param {{ directory: string; files: readonly string[] }} input
 * @returns {number}
 */
export function writeChecksums({ directory, files }) {
  const names = [...new Set(files.map((file) => path.basename(file)))].sort()
  const lines = names.map((name) => `${sha256(path.join(directory, name))}  ${name}`)
  writeFileSync(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return names.length
}

/**
 * 列出 staging 中实际安装的 npm 包（含扁平化的传递依赖）。
 * @param {string} nodeModules
 * @returns {{ name: string; version: string; license: string }[]}
 */
export function listInstalledPackages(nodeModules) {
  /** @type {{ name: string; version: string; license: string }[]} */
  const packages = []
  /** @param {string} directory */
  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      const target = path.join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        visitScope(target)
      } else {
        visitPackage(target)
      }
    }
  }
  /** @param {string} scope */
  const visitScope = (scope) => {
    let entries
    try {
      entries = readdirSync(scope, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visitPackage(path.join(scope, entry.name))
    }
  }
  /** @param {string} directory */
  const visitPackage = (directory) => {
    const manifest = path.join(directory, 'package.json')
    if (!existsSync(manifest)) return
    const parsed = readJson(manifest)
    packages.push({
      name: String(parsed['name'] ?? path.basename(directory)),
      version: String(parsed['version'] ?? ''),
      license: typeof parsed['license'] === 'string' ? parsed['license'] : '',
    })
    visit(path.join(directory, 'node_modules'))
  }
  visit(nodeModules)
  return [...new Map(packages.map((item) => [`${item.name}@${item.version}`, item])).values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  )
}

/**
 * 生成依赖清单：staging 中实际随包分发的 npm 包与外部二进制。
 * @param {{
 *   stageDir: string;
 *   bundled: { binaries?: readonly Record<string, any>[] };
 *   electronVersion: string;
 *   nodeVersion: string;
 * }} input
 * @returns {Record<string, any>}
 */
export function buildDependenciesManifest({ stageDir, bundled, electronVersion, nodeVersion }) {
  const manifest = readJson(path.join(stageDir, 'package.json'))
  return {
    schemaVersion: 1,
    electron: electronVersion,
    node: nodeVersion,
    direct: Object.keys(manifest.dependencies ?? {}).sort(),
    dependencies: listInstalledPackages(path.join(stageDir, 'node_modules')),
    binaries: (bundled.binaries ?? []).map((binary) => ({
      name: binary['name'],
      version: binary['version'],
      license: binary['license'],
      source: binary['source'],
    })),
  }
}

/**
 * 生成发布说明。签名状态是强制章节，unsigned beta 明确警告 SmartScreen。
 * @param {{
 *   version: string;
 *   channel: 'stable' | 'beta';
 *   commit: string;
 *   buildTime: string;
 *   changelogSection: string;
 *   signing: Record<string, any>;
 *   installer?: string;
 *   installerSha256?: string;
 *   platform?: string;
 *   downloads?: readonly { name: string; sha256: string }[];
 * }} input
 * @returns {string}
 */
export function renderReleaseNotes({
  version,
  channel,
  commit,
  buildTime,
  changelogSection,
  signing,
  installer,
  installerSha256,
  platform = 'windows',
  downloads,
}) {
  const spec = platformSpec(platform)
  const metadataName = spec.metadataName(channel)
  const packageTarget = platform === 'windows' ? 'nsis' : platform
  const files =
    downloads ?? (installer === undefined ? [] : [{ name: installer, sha256: installerSha256 }])
  return [
    `# Cairn ${version} 发布说明（${spec.label}）`,
    '',
    '## 版本与通道',
    '',
    `- 版本：\`${version}\``,
    `- 通道：\`${channel}\``,
    `- 构建提交：\`${commit}\``,
    `- 构建时间：\`${buildTime}\``,
    `- 支持系统：${spec.support[0]}`,
    `- 安装形态：${spec.support[1]}`,
    '',
    '## 本次变化',
    '',
    changelogSection,
    '',
    '## 签名状态',
    '',
    ...signingLines(platform, signing),
    '',
    '## 已知问题',
    '',
    ...spec.knownIssues.map((issue) => `- ${issue}`),
    '',
    '## 验证范围',
    '',
    '- 单元、集成与覆盖率门禁：`pnpm test:coverage`',
    '- 构建与冒烟：`pnpm build`、`pnpm smoke`',
    '- 端到端：`pnpm e2e`',
    `- 安装包构建与校验：\`pnpm package:${packageTarget}\`、\`pnpm package:verify -- --${packageTarget}\``,
    `- 自动更新：本发布产物的 \`${metadataName}\` 校验`,
    '',
    '## 下载与校验',
    '',
    ...files.flatMap((file) => [`- 安装包：\`${file.name}\``, `- SHA-256：\`${file.sha256}\``]),
    `- 更新元数据：\`${metadataName}\``,
    '- 第三方声明与 GPL 源码获取方式：安装目录 `THIRD_PARTY_NOTICES.txt`、应用内关于页',
    '',
  ].join('\n')
}

/**
 * 每个平台的签名说明。Linux 没有统一代码签名，不能写成 SmartScreen 警告。
 * @param {string} platform
 * @param {Record<string, any>} signing
 * @returns {string[]}
 */
export function signingLines(platform, signing) {
  if (platform === 'linux') {
    return [
      '- 安装包与主程序：**未签名**（Linux 无统一代码签名体系）',
      '- 完整性：SHA-256 校验和与 HTTPS 更新源；仓库签名留待后续分发渠道',
    ]
  }
  if (platform === 'mac') {
    if (signing['mode'] === 'none') {
      return [
        '- 应用与安装包：**unsigned beta**',
        '- 未签名版本可能被 Gatekeeper 阻止；不得宣称“已验证发布者”或“无警告”。',
      ]
    }
    return [
      `- 应用与安装包：已签名（${String(signing['mode'])}）并公证`,
      `- Developer ID 身份：${String(signing['identity'] ?? '未配置')}`,
      '- 公证：由 electron-builder 调用 notarytool；`pnpm sign:verify:mac` 校验签名与 stapling',
    ]
  }
  const signed = signing['mode'] !== 'none'
  return [
    signed
      ? `- 安装包、主程序与卸载程序：已签名（${String(signing['mode'])}）`
      : '- 安装包、主程序与卸载程序：**unsigned beta**',
    `- 证书主题与 \`publisherName\`：${String(signing['publisher'] ?? '未配置（unsigned）')}`,
    `- 时间戳服务：${String(signing['timestampUrl'] ?? '未使用')}`,
    ...(signed
      ? []
      : ['- 未签名版本可能触发 SmartScreen 警告；不得宣称“已验证发布者”或“无警告”。']),
  ]
}

/**
 * @param {{
 *   version: string;
 *   channel: 'stable' | 'beta';
 *   commit: string;
 *   buildTime: string;
 *   signing: Record<string, unknown>;
 *   artifacts: readonly { name: string; sha256: string; size: number }[];
 *   env: Readonly<Record<string, string | undefined>>;
 *   platform?: string;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function renderProvenance({
  version,
  channel,
  commit,
  buildTime,
  signing,
  artifacts,
  env,
  platform,
}) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    ...(platform === undefined ? {} : { platform }),
    version,
    channel,
    commit,
    buildTime,
    repository: env['GITHUB_REPOSITORY'] ?? 'local',
    workflow: env['GITHUB_WORKFLOW_REF'] ?? 'local',
    runId: env['GITHUB_RUN_ID'] ?? '',
    runAttempt: env['GITHUB_RUN_ATTEMPT'] ?? '',
    serverUrl: env['GITHUB_SERVER_URL'] ?? '',
    signing,
    artifacts,
  }
}

/**
 * 校验 electron-builder 写出的 `latest.yml` 与安装包一致。
 * @param {{ metadata: string; version: string; installer: string; sha512: string; size: number }} input
 * @returns {string[]}
 */
export function validateUpdateMetadata({ metadata, version, installer, sha512, size }) {
  const problems = []
  /** @param {string} name */
  const value = (name) => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(metadata)
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  }
  if (value('version') !== version) problems.push('latest.yml version does not match the build')
  if (value('path') !== installer) problems.push('latest.yml path does not match the installer')
  if (value('sha512') !== sha512) problems.push('latest.yml sha512 does not match the installer')
  const urls = [...metadata.matchAll(/^\s+- url:\s*(.+)$/gm)].map((match) =>
    (match[1] ?? '').trim().replace(/^['"]|['"]$/g, ''),
  )
  if (urls.length !== 1 || urls[0] !== installer) {
    problems.push('latest.yml must reference exactly the built installer')
  }
  if (!new RegExp(`^\\s+size:\\s*${size}$`, 'm').test(metadata)) {
    problems.push('latest.yml size does not match the installer')
  }
  return problems
}

/**
 * 整理发布产物；返回输出目录与清单，失败时抛出。
 * @param {{
 *   distDir?: string | undefined;
 *   outDir?: string | undefined;
 *   desktopRoot?: string | undefined;
 *   version?: string | undefined;
 *   channel: 'stable' | 'beta';
 *   platform?: string;
 *   env?: Readonly<Record<string, string | undefined>> | undefined;
 * }} options
 * @returns {{
 *   outDir: string;
 *   metadata: string;
 *   files: string[];
 *   releaseNotes: string;
 *   platformNotes: Record<string, any>;
 * }}
 */
export function releaseArtifacts({
  distDir,
  outDir,
  desktopRoot = DESKTOP_ROOT,
  version,
  channel,
  platform = 'windows',
  env = process.env,
}) {
  const spec = platformSpec(platform)
  const manifest = readJson(path.join(desktopRoot, 'package.json'))
  const releaseVersion = version ?? String(manifest.version)
  if (manifest.version !== releaseVersion) {
    throw new Error(`version ${releaseVersion} does not match apps/desktop/package.json`)
  }
  const dist = distDir ?? path.join(desktopRoot, 'dist')
  const out = outDir ?? path.join(dist, 'release')
  const artifactNames = spec.artifacts(releaseVersion)
  const blockmapNames = spec.blockmaps(releaseVersion)
  const updatableNames = spec.updatable(releaseVersion)
  const builderMetadata = path.join(dist, spec.builderMetadata)
  for (const name of [...artifactNames, ...blockmapNames]) {
    const file = path.join(dist, name)
    if (!existsSync(file)) throw new Error(`release artifact is missing: ${file}`)
  }
  if (!existsSync(builderMetadata)) {
    throw new Error(`release artifact is missing: ${builderMetadata}`)
  }

  const signing = platformSigningSummary(platform, env)
  if (channel === 'stable' && platform !== 'linux' && signing['mode'] === 'none') {
    throw new Error(`${spec.label} stable releases must be signed`)
  }

  const buildInfo = readJson(path.join(desktopRoot, 'out', 'build-info.json'))
  if (buildInfo['version'] !== releaseVersion) {
    throw new Error('build-info.json version does not match the release')
  }
  if (buildInfo['channel'] !== channel) {
    throw new Error('build-info.json channel does not match the release channel')
  }
  if (typeof buildInfo['commit'] !== 'string' || !/^[0-9a-f]{7,40}$/.test(buildInfo['commit'])) {
    throw new Error('build-info.json has no usable commit; build from a git checkout')
  }

  const updatable = updatableNames.map((name) => {
    const file = path.join(dist, name)
    return {
      name,
      sha512: createHash('sha512').update(readFileSync(file)).digest('base64'),
      size: statSync(file).size,
      sha256: sha256(file),
    }
  })
  const problems = validateUpdateMetadataFiles({
    metadata: readFileSync(builderMetadata, 'utf8'),
    version: releaseVersion,
    files: updatable,
    allowedExtra: artifactNames.filter((name) => !updatableNames.includes(name)),
  })
  if (problems.length > 0) {
    throw new Error(problems.map((problem) => `${spec.builderMetadata}: ${problem}`).join('; '))
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const metadataName = spec.metadataName(channel)
  for (const name of [...artifactNames, ...blockmapNames]) {
    copyFileSync(path.join(dist, name), path.join(out, name))
  }
  writeFileSync(
    path.join(out, metadataName),
    renderUpdateMetadataFiles({
      version: releaseVersion,
      files: updatable,
      releaseDate: String(buildInfo['buildTime'] ?? ''),
    }),
  )
  copyFileSync(
    path.join(desktopRoot, 'out', 'THIRD_PARTY_NOTICES.txt'),
    path.join(out, 'THIRD_PARTY_NOTICES.txt'),
  )
  const dependencies = buildDependenciesManifest({
    stageDir: path.join(desktopRoot, '.package', 'app'),
    bundled: readJson(path.join(desktopRoot, '..', '..', 'scripts', 'bundled-binaries.json')),
    electronVersion: String(buildInfo['electronVersion'] ?? ''),
    nodeVersion: String(buildInfo['nodeVersion'] ?? ''),
  })
  writeFileSync(
    path.join(out, 'dependencies.json'),
    `${JSON.stringify(dependencies, null, 2)}
`,
  )

  const changelog = readFileSync(path.resolve(desktopRoot, '..', '..', 'CHANGELOG.md'), 'utf8')
  const changelogSection = extractChangelogSection(changelog, releaseVersion)
  const downloads = artifactNames.map((name) => ({ name, sha256: sha256(path.join(out, name)) }))
  const releaseNotes = renderReleaseNotes({
    version: releaseVersion,
    channel,
    commit: String(buildInfo['commit']),
    buildTime: String(buildInfo['buildTime'] ?? ''),
    changelogSection,
    signing,
    platform,
    downloads,
  })
  writeFileSync(path.join(out, 'release-notes.md'), releaseNotes)

  /** @type {Record<string, any>} */
  const platformNotes = {
    schemaVersion: PLATFORM_NOTES_SCHEMA_VERSION,
    platform,
    label: spec.label,
    version: releaseVersion,
    channel,
    commit: String(buildInfo['commit']),
    buildTime: String(buildInfo['buildTime'] ?? ''),
    signing,
    metadata: metadataName,
    support: spec.support,
    install: spec.install,
    knownIssues: spec.knownIssues,
    changelogSection,
    downloads: downloads.map((file) => ({
      name: file.name,
      sha256: file.sha256,
      size: statSync(path.join(out, file.name)).size,
    })),
  }
  writeFileSync(
    path.join(out, 'platform-notes.json'),
    `${JSON.stringify(platformNotes, null, 2)}
`,
  )

  /** @type {string[]} */
  const artifactNamesInRelease = readdirSync(out)
    .filter((name) => name !== 'SHA256SUMS' && name !== 'provenance.json')
    .sort()
  const artifacts = artifactNamesInRelease.map((name) => {
    const file = path.join(out, name)
    return { name, sha256: sha256(file), size: statSync(file).size }
  })
  writeFileSync(
    path.join(out, 'provenance.json'),
    `${JSON.stringify(
      renderProvenance({
        version: releaseVersion,
        channel,
        commit: String(buildInfo['commit']),
        buildTime: String(buildInfo['buildTime'] ?? ''),
        signing,
        artifacts,
        env,
        platform,
      }),
      null,
      2,
    )}
`,
  )
  const checksummed = readdirSync(out).filter((name) => name !== 'SHA256SUMS')
  writeChecksums({ directory: out, files: checksummed })
  return {
    outDir: out,
    metadata: metadataName,
    files: readdirSync(out).sort(),
    releaseNotes,
    platformNotes,
  }
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   env?: Readonly<Record<string, string | undefined>>;
 *   desktopRoot?: string;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  desktopRoot = DESKTOP_ROOT,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  /** @param {string} flag */
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const channel = value('--channel') ?? env['CAIRN_CHANNEL'] ?? 'beta'
  const platform = value('--platform') ?? 'windows'
  if (channel !== 'stable' && channel !== 'beta') {
    error(
      'usage: release-artifacts.mjs --channel stable|beta [--platform windows|mac|linux] [--dist <dir>] [--out <dir>]',
    )
    return 1
  }
  if (!RELEASE_PLATFORMS.includes(platform)) {
    error(`--platform must be one of ${RELEASE_PLATFORMS.join(', ')}`)
    return 1
  }
  try {
    const result = releaseArtifacts({
      distDir: value('--dist'),
      outDir: value('--out'),
      desktopRoot,
      version: value('--version'),
      channel,
      platform,
      env,
    })
    log(`release: ${result.files.length} files in ${result.outDir}`)
    log(`release: update metadata ${result.metadata}`)
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
