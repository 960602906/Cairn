// @ts-check
/**
 * 发布产物整理（M5-08）：把 electron-builder 的输出变成可上传、可校验、可追溯的一组文件。
 *
 * 产物目录包含：
 * - NSIS 安装包与 blockmap；
 * - `latest.yml`（stable）或 `beta.yml`（beta）更新元数据；
 * - `SHA256SUMS`（对目录内除自身外的全部文件）；
 * - `THIRD_PARTY_NOTICES.txt`、`dependencies.json`；
 * - `release-notes.md`（从 CHANGELOG 抽取本节，附签名状态）；
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
import { readSigningConfig, signatureSummary } from '@cairn/release-tools'

export const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..', 'apps/desktop')
export const PRODUCT_NAME = 'Cairn'
export const PROVENANCE_SCHEMA_VERSION = 1

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
 *   signing: ReturnType<typeof signatureSummary>;
 *   installer: string;
 *   installerSha256: string;
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
}) {
  const signed = signing.mode !== 'none'
  return [
    `# Cairn ${version} 发布说明`,
    '',
    '## 版本与通道',
    '',
    `- 版本：\`${version}\``,
    `- 通道：\`${channel}\``,
    `- 构建提交：\`${commit}\``,
    `- 构建时间：\`${buildTime}\``,
    '- 支持系统：Windows 11（至少 24H2，正式支持）；Windows 10 22H2（best-effort）',
    '- 安装形态：Windows x64、NSIS、按用户安装、无需管理员',
    '',
    '## 本次变化',
    '',
    changelogSection,
    '',
    '## 签名状态',
    '',
    signed
      ? `- 安装包、主程序与卸载程序：已签名（${signing.mode}）`
      : '- 安装包、主程序与卸载程序：**unsigned beta**',
    `- 证书主题与 \`publisherName\`：${signing.publisher ?? '未配置（unsigned）'}`,
    `- 时间戳服务：${signing.timestampUrl ?? '未使用'}`,
    ...(signed
      ? []
      : ['- 未签名版本可能触发 SmartScreen 警告；不得宣称“已验证发布者”或“无警告”。']),
    '',
    '## 已知问题',
    '',
    '- 沙箱默认档位限制工作区外写入与管理员权限，但网络尚未隔离；需要联网的命令按审批执行。',
    '- 自动更新不做二进制降级；数据库版本过新时拒绝启动。',
    '- Windows 10 22H2 已结束微软支持，仅尽力兼容。',
    '',
    '## 验证范围',
    '',
    '- 单元、集成与覆盖率门禁：`pnpm test:coverage`',
    '- 构建与冒烟：`pnpm build`、`pnpm smoke`',
    '- 端到端：`pnpm e2e`',
    '- 安装、启动、卸载与保留用户数据：`pnpm smoke:installed`',
    '- 自动更新：本地静态源 e2e + 本发布产物的 `latest.yml` / `beta.yml` 校验',
    '',
    '## 下载与校验',
    '',
    `- 安装包：\`${installer}\``,
    `- SHA-256：\`${installerSha256}\``,
    `- 更新元数据：\`${channel === 'stable' ? 'latest.yml' : 'beta.yml'}\` 与 blockmap`,
    '- 第三方声明与 GPL 源码获取方式：安装目录 `THIRD_PARTY_NOTICES.txt`、应用内关于页',
    '',
  ].join('\n')
}

/**
 * @param {{
 *   version: string;
 *   channel: 'stable' | 'beta';
 *   commit: string;
 *   buildTime: string;
 *   signing: ReturnType<typeof signatureSummary>;
 *   artifacts: readonly { name: string; sha256: string; size: number }[];
 *   env: Readonly<Record<string, string | undefined>>;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function renderProvenance({ version, channel, commit, buildTime, signing, artifacts, env }) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
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
 *   env?: Readonly<Record<string, string | undefined>> | undefined;
 * }} options
 * @returns {{ outDir: string; metadata: string; files: string[]; releaseNotes: string }}
 */
export function releaseArtifacts({
  distDir,
  outDir,
  desktopRoot = DESKTOP_ROOT,
  version,
  channel,
  env = process.env,
}) {
  const manifest = readJson(path.join(desktopRoot, 'package.json'))
  const releaseVersion = version ?? String(manifest.version)
  if (manifest.version !== releaseVersion) {
    throw new Error(`version ${releaseVersion} does not match apps/desktop/package.json`)
  }
  const dist = distDir ?? path.join(desktopRoot, 'dist')
  const out = outDir ?? path.join(dist, 'release')
  const installerName = `${PRODUCT_NAME}-${releaseVersion}-x64-setup.exe`
  const installer = path.join(dist, installerName)
  const blockmap = `${installer}.blockmap`
  const builderMetadata = path.join(dist, 'latest.yml')
  for (const file of [installer, blockmap, builderMetadata]) {
    if (!existsSync(file)) throw new Error(`release artifact is missing: ${file}`)
  }

  const signingConfig = readSigningConfig(env)
  if (channel === 'stable' && signingConfig.mode === 'none') {
    throw new Error('stable releases must be signed')
  }
  const signing = signatureSummary(signingConfig)

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

  const installerSha512 = createHash('sha512').update(readFileSync(installer)).digest('base64')
  const installerSha256 = sha256(installer)
  const installerSize = statSync(installer).size
  const problems = validateUpdateMetadata({
    metadata: readFileSync(builderMetadata, 'utf8'),
    version: releaseVersion,
    installer: installerName,
    sha512: installerSha512,
    size: installerSize,
  })
  if (problems.length > 0) throw new Error(problems.join('; '))

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const metadataName = channel === 'stable' ? 'latest.yml' : 'beta.yml'
  copyFileSync(installer, path.join(out, installerName))
  copyFileSync(blockmap, path.join(out, path.basename(blockmap)))
  writeFileSync(
    path.join(out, metadataName),
    renderUpdateMetadata({
      version: releaseVersion,
      installer: installerName,
      sha512: installerSha512,
      size: installerSize,
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
  writeFileSync(path.join(out, 'dependencies.json'), `${JSON.stringify(dependencies, null, 2)}\n`)

  const changelog = readFileSync(path.resolve(desktopRoot, '..', '..', 'CHANGELOG.md'), 'utf8')
  const releaseNotes = renderReleaseNotes({
    version: releaseVersion,
    channel,
    commit: String(buildInfo['commit']),
    buildTime: String(buildInfo['buildTime'] ?? ''),
    changelogSection: extractChangelogSection(changelog, releaseVersion),
    signing,
    installer: installerName,
    installerSha256,
  })
  writeFileSync(path.join(out, 'release-notes.md'), releaseNotes)

  /** @type {string[]} */
  const artifactNames = readdirSync(out)
    .filter((name) => name !== 'SHA256SUMS' && name !== 'provenance.json')
    .sort()
  const artifacts = artifactNames.map((name) => {
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
      }),
      null,
      2,
    )}\n`,
  )
  const checksummed = readdirSync(out).filter((name) => name !== 'SHA256SUMS')
  writeChecksums({ directory: out, files: checksummed })
  return {
    outDir: out,
    metadata: metadataName,
    files: readdirSync(out).sort(),
    releaseNotes,
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
  if (channel !== 'stable' && channel !== 'beta') {
    error('usage: release-artifacts.mjs --channel stable|beta [--dist <dir>] [--out <dir>]')
    return 1
  }
  try {
    const result = releaseArtifacts({
      distDir: value('--dist'),
      outDir: value('--out'),
      desktopRoot,
      version: value('--version'),
      channel,
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
