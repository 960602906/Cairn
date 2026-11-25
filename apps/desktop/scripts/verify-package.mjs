// @ts-check
/**
 * 打包产物校验（M5-02，ADR-0035）。
 *
 * 只检查产物本身，不启动应用：必需文件、asar 中不应出现的内容、原生模块与 ripgrep
 * （Windows 为 `rg.exe`，macOS/Linux 为 `rg`）、技能资源、Electron fuses、NSIS 安装包、
 * macOS DMG/ZIP 或 Linux AppImage/deb 与校验和。真实的 SQLite、koffi、ripgrep 与技能加载由 `smoke:packaged`
 * 启动已打包程序验证。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { BUILTIN_SMOKE_SKILL } from './builtin-skill.mjs'

export const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
export const DEFAULT_OUTPUT_DIR = path.join(DESKTOP_ROOT, 'dist')

/** 随包的 ripgrep 在 `app.asar` 里的相对路径。 */
export function bundledRipgrepPath(platform = process.platform) {
  return `out/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`
}

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
function requiredAsar(platform = process.platform) {
  return [
    'out/main/index.js',
    'out/main/startup.js',
    'out/main/agent-host.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    bundledRipgrepPath(platform),
    'out/build-info.json',
    'out/THIRD_PARTY_NOTICES.txt',
    'package.json',
  ]
}

const FORBIDDEN_PREFIXES = [
  'src/',
  'e2e/',
  'spikes/',
  'node_modules/electron/',
  'node_modules/react/',
  'node_modules/react-dom/',
  'node_modules/vite/',
  'node_modules/typescript/',
  'node_modules/@playwright/',
  'node_modules/@testing-library/',
]

/** @type {readonly [FuseV1Options, FuseState, string][]} */
const EXPECTED_FUSES = [
  [FuseV1Options.RunAsNode, FuseState.DISABLE, 'runAsNode disabled'],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE, 'cookie encryption enabled'],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE, 'NODE_OPTIONS disabled'],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE, 'CLI inspector disabled'],
  [
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseState.ENABLE,
    'asar integrity validation enabled',
  ],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE, 'onlyLoadAppFromAsar enabled'],
  [
    FuseV1Options.GrantFileProtocolExtraPrivileges,
    FuseState.ENABLE,
    'file protocol privileges enabled',
  ],
]

/**
 * @param {string} value
 * @returns {string}
 */
function normalized(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '')
}

/**
 * 统一错误文本，避免各个 catch 各自处理非 Error 值。
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function findFiles(dir, pattern) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

/**
 * electron-builder 的未打包目录：Windows 固定 `win-unpacked`，macOS 按架构分
 * `mac`（x64）与 `mac-arm64`，Linux 为 `linux-unpacked`。
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.Architecture} [arch]
 * @returns {string}
 */
export function unpackedDirectoryName(platform = process.platform, arch = 'x64') {
  if (platform === 'win32') return 'win-unpacked'
  if (platform === 'darwin') return arch === 'x64' ? 'mac' : `mac-${arch}`
  return 'linux-unpacked'
}

/**
 * 产物里的资源目录：macOS 在 `Cairn.app/Contents/Resources`，其他平台在 `<app>/resources`。
 * @param {{ directory: string; executable: string }} app
 * @param {NodeJS.Platform} [platform]
 * @param {string} [productName]
 * @returns {string}
 */
export function packagedResourcesDirectory(
  app,
  platform = process.platform,
  productName = 'Cairn',
) {
  if (platform === 'darwin') {
    return path.join(app.directory, `${productName}.app`, 'Contents', 'Resources')
  }
  return path.join(app.directory, 'resources')
}

/**
 * 定位 electron-builder 的未打包应用目录与主程序。
 * @param {{
 *   outputDir?: string;
 *   platform?: NodeJS.Platform;
 *   arch?: NodeJS.Architecture;
 *   productName?: string;
 *   packageName?: string;
 * }} [options]
 * @returns {{ directory: string; executable: string }}
 */
export function findUnpackedApp({
  outputDir = DEFAULT_OUTPUT_DIR,
  platform = process.platform,
  arch = 'x64',
  productName = 'Cairn',
  packageName = '@cairn/desktop',
} = {}) {
  const directory = path.join(outputDir, unpackedDirectoryName(platform, arch))
  /** @type {string[]} */
  let candidates
  if (platform === 'win32') {
    candidates = [path.join(directory, `${productName}.exe`)]
  } else if (platform === 'darwin') {
    candidates = [path.join(directory, `${productName}.app/Contents/MacOS/${productName}`)]
  } else {
    const shortName = packageName.slice(packageName.lastIndexOf('/') + 1)
    candidates = [
      path.join(directory, productName.toLowerCase()),
      path.join(directory, productName),
      path.join(directory, shortName),
    ]
  }
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (executable === undefined) {
    throw new Error(
      `packaged application was not found in ${directory}; run \`pnpm package:dir\` first`,
    )
  }
  return { directory, executable }
}

/**
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * @param {string} file
 * @param {string} expected
 * @returns {boolean}
 */
function checksumMatches(file, expected) {
  const declared = readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0]
  return declared === expected
}

/**
 * 用系统 Node 加载原生模块，捕获 ABI/依赖错误。
 * @param {string} file
 * @param {typeof spawnSync} runner
 * @returns {string | undefined} 失败原因
 */
function loadNativeModule(file, runner) {
  const result = runner(
    process.execPath,
    ['-e', "require(require('node:path').resolve(process.argv[1]))", file],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  )
  if (result.status === 0) return undefined
  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
  return `${path.basename(file)} failed to load${detail === '' ? '' : `: ${detail.slice(0, 500)}`}`
}

/**
 * @param {string} executable
 * @param {(executable: string) => Promise<Record<number, FuseState>>} [readWire]
 * @returns {Promise<string[]>}
 */
export async function verifyFuses(executable, readWire = getCurrentFuseWire) {
  const problems = []
  try {
    const wire = await readWire(executable)
    for (const [option, expected, label] of EXPECTED_FUSES) {
      const actual = wire[option]
      if (actual !== expected) {
        problems.push(`fuse is not ${label}: ${String(actual)}`)
      }
    }
  } catch (error) {
    problems.push(
      `cannot read Electron fuses: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return problems
}

/**
 * 检查解包应用与安装包，返回问题列表（空数组表示通过）。
 * @param {{
 *   desktopRoot?: string;
 *   outputDir?: string;
 *   target?: 'dir' | 'nsis' | 'mac' | 'linux';
 *   platform?: NodeJS.Platform;
 *   arch?: NodeJS.Architecture;
 *   runner?: typeof spawnSync;
 *   readFuses?: (executable: string) => Promise<string[]>;
 *   minimumInstallerBytes?: number;
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function verifyPackage({
  desktopRoot = DESKTOP_ROOT,
  outputDir = DEFAULT_OUTPUT_DIR,
  target = 'dir',
  platform = process.platform,
  arch = process.arch,
  runner = spawnSync,
  readFuses = verifyFuses,
  minimumInstallerBytes = 50 * 1024 * 1024,
} = {}) {
  /** @type {string[]} */
  const problems = []
  let app
  try {
    app = findUnpackedApp({
      outputDir,
      platform,
      arch,
      productName: 'Cairn',
      packageName: '@cairn/desktop',
    })
  } catch (error) {
    return [errorMessage(error)]
  }
  const resourcesDir = packagedResourcesDirectory(app, platform)
  const appAsar = path.join(resourcesDir, 'app.asar')
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked')
  const sqlitePrebuild = `${platform}-${arch}.node`
  for (const { file, label } of [
    { file: app.executable, label: 'main executable' },
    { file: appAsar, label: 'app.asar' },
    {
      file: path.join(resourcesDir, 'skills', BUILTIN_SMOKE_SKILL, 'SKILL.md'),
      label: 'resources/skills',
    },
    { file: path.join(resourcesDir, 'app-update.yml'), label: 'app-update.yml' },
    // 随包 MinGit 只在 Windows 上分发（ADR-0008）。
    ...(platform === 'win32'
      ? [{ file: path.join(resourcesDir, 'git/LICENSE.txt'), label: 'resources/git license' }]
      : []),
  ]) {
    if (!existsSync(file)) problems.push(`missing ${label}: ${file}`)
  }
  // electron-updater 下载更新时会读取该文件；`--publish never` 不会自动生成（M5-10）。
  // 只允许两种公开只读源：generic HTTPS 目录，或公开仓库的 GitHub Releases。
  const updateConfig = path.join(resourcesDir, 'app-update.yml')
  if (existsSync(updateConfig)) {
    const content = readFileSync(updateConfig, 'utf8')
    const provider = /^provider:\s*(\S+)\s*$/m.exec(content)?.[1] ?? ''
    if (provider === 'generic') {
      if (!/^url:\s*https:\/\/\S+$/m.test(content)) {
        problems.push('app-update.yml does not contain an https update URL')
      }
    } else if (provider === 'github') {
      if (!/^owner:\s*\S+$/m.test(content) || !/^repo:\s*\S+$/m.test(content)) {
        problems.push('app-update.yml GitHub provider is missing owner or repo')
      }
    } else {
      problems.push(`app-update.yml uses an unsupported provider: ${provider.slice(0, 40)}`)
    }
  }
  const bundledGit = path.join(resourcesDir, 'git/ucrt64/bin/git.exe')
  if (platform === 'win32' && !existsSync(bundledGit)) {
    problems.push(`missing bundled MinGit: ${bundledGit}`)
  }
  if (!existsSync(appAsar)) return problems

  const entries = new Set(listPackage(appAsar, { isPack: false }).map(normalized))
  for (const required of requiredAsar(platform)) {
    if (!entries.has(required)) problems.push(`app.asar is missing ${required}`)
  }
  for (const entry of entries) {
    if (entry.endsWith('.map')) problems.push(`app.asar contains a source map: ${entry}`)
    if (/\.test\.[^/]+$/.test(entry)) problems.push(`app.asar contains a test file: ${entry}`)
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (entry.startsWith(prefix)) {
        problems.push(`app.asar contains development content: ${entry}`)
      }
    }
  }

  try {
    const manifest = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'))
    const desktopManifest = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
    if (manifest.version !== desktopManifest.version) {
      problems.push(
        `app.asar version ${String(manifest.version)} does not match ${String(desktopManifest.version)}`,
      )
    }
    if (manifest.scripts !== undefined) problems.push('app.asar package.json contains scripts')
    const devDependencies = Object.keys(manifest.devDependencies ?? {})
    if (devDependencies.some((name) => name !== 'electron')) {
      problems.push(`app.asar contains development dependencies: ${devDependencies.join(', ')}`)
    }
  } catch (error) {
    problems.push(`cannot read app.asar/package.json: ${errorMessage(error)}`)
  }

  try {
    const buildInfo = JSON.parse(extractFile(appAsar, 'out/build-info.json').toString('utf8'))
    const manifest = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'))
    if (buildInfo.version !== manifest.version) {
      problems.push('out/build-info.json version does not match app.asar/package.json')
    }
  } catch (error) {
    problems.push(`cannot read out/build-info.json: ${errorMessage(error)}`)
  }

  for (const { label, pattern } of [
    { label: 'ripgrep', pattern: platform === 'win32' ? /^rg\.exe$/i : /^rg$/ },
    {
      label: 'better-sqlite3 native module',
      pattern: new RegExp(`^${sqlitePrebuild.replaceAll('.', '\\.')}$`, 'i'),
    },
    { label: 'koffi native module', pattern: /\.node$/i },
  ]) {
    const roots =
      label === 'ripgrep'
        ? [path.join(unpacked, 'out/bin')]
        : label === 'better-sqlite3 native module'
          ? [path.join(unpacked, 'node_modules/better-sqlite3')]
          : [
              path.join(unpacked, 'node_modules/@koromix'),
              path.join(unpacked, 'node_modules/koffi'),
            ]
    const files = roots.flatMap((root) => findFiles(root, pattern))
    if (files.length === 0) problems.push(`asarUnpack is missing ${label}`)
  }
  for (const required of [
    'node_modules/koffi/index.js',
    'node_modules/koffi/src/koffi/index.js',
    'node_modules/koffi/index.cjs',
    'node_modules/koffi/src/koffi/index.cjs',
  ]) {
    if (!existsSync(path.join(unpacked, required))) {
      problems.push(`asarUnpack is missing ${required}`)
    }
  }

  const rg = path.join(unpacked, bundledRipgrepPath(platform))
  if (existsSync(rg)) {
    const result = runner(rg, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (result.status !== 0 || !String(result.stdout).startsWith('ripgrep ')) {
      problems.push(`bundled ripgrep cannot run: ${String(result.stderr).trim()}`)
    }
  }

  // 随包 MinGit（M5-03）：必须能启动，且裁剪掉凭据管理器与 HTTP 传输（ADR-0008）。
  if (existsSync(bundledGit)) {
    const result = runner(bundledGit, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (result.status !== 0 || !String(result.stdout).includes('git version 2.56')) {
      problems.push(`bundled MinGit cannot run: ${String(result.stderr).trim()}`)
    }
    for (const forbidden of ['git-remote-http.exe', 'git-remote-https.exe', 'scalar.exe']) {
      if (existsSync(path.join(resourcesDir, 'git/ucrt64/bin', forbidden))) {
        problems.push(`bundled MinGit should not contain ${forbidden}`)
      }
    }
  }

  for (const { label, root, pattern } of [
    {
      label: 'better-sqlite3 native module',
      root: path.join(unpacked, 'node_modules/better-sqlite3'),
      pattern: new RegExp(`^${sqlitePrebuild.replaceAll('.', '\\.')}$`, 'i'),
    },
    {
      label: 'koffi native module',
      root: path.join(unpacked, 'node_modules/@koromix'),
      pattern: /\.node$/i,
    },
  ]) {
    const [file] = findFiles(root, pattern)
    if (file !== undefined) {
      const failure = loadNativeModule(file, runner)
      if (failure !== undefined) problems.push(`${label} cannot load: ${failure}`)
    }
  }

  problems.push(...(await readFuses(app.executable)))

  const manifest = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
  const version = String(manifest.version)
  if (target === 'mac') {
    for (const artifactArch of ['arm64', 'x64']) {
      for (const ext of ['dmg', 'zip']) {
        const file = path.join(outputDir, `Cairn-${version}-${artifactArch}.${ext}`)
        const checksum = `${file}.sha256`
        if (!existsSync(file)) {
          problems.push(`missing macOS ${ext}: ${file}`)
          continue
        }
        if (!existsSync(checksum)) {
          problems.push(`missing macOS ${ext} checksum: ${checksum}`)
        } else if (!checksumMatches(file, sha256(file))) {
          problems.push(`macOS ${ext} checksum does not match: ${path.basename(file)}`)
        }
        if (ext === 'dmg' && statSync(file).size < minimumInstallerBytes) {
          problems.push(`macOS DMG is unexpectedly small: ${path.basename(file)}`)
        }
      }
    }
  }
  if (target === 'linux') {
    for (const ext of ['AppImage', 'deb']) {
      const file = path.join(outputDir, `Cairn-${version}-x64.${ext}`)
      const checksum = `${file}.sha256`
      if (!existsSync(file)) {
        problems.push(`missing Linux ${ext}: ${file}`)
        continue
      }
      if (!existsSync(checksum)) {
        problems.push(`missing Linux ${ext} checksum: ${checksum}`)
      } else if (!checksumMatches(file, sha256(file))) {
        problems.push(`Linux ${ext} checksum does not match: ${path.basename(file)}`)
      }
      if (statSync(file).size < minimumInstallerBytes) {
        problems.push(`Linux ${ext} is unexpectedly small: ${path.basename(file)}`)
      }
    }
  }
  if (target === 'nsis') {
    const installer = path.join(outputDir, `Cairn-${String(manifest.version)}-x64-setup.exe`)
    for (const { file, label } of [
      { file: installer, label: 'NSIS installer' },
      { file: `${installer}.blockmap`, label: 'NSIS blockmap' },
      { file: `${installer}.sha256`, label: 'NSIS checksum' },
    ]) {
      if (!existsSync(file)) problems.push(`missing ${label}: ${file}`)
    }
    if (existsSync(installer) && existsSync(`${installer}.sha256`)) {
      if (!checksumMatches(installer, sha256(installer))) {
        problems.push('NSIS checksum does not match the installer')
      }
      const size = statSync(installer).size
      if (size < minimumInstallerBytes) {
        problems.push(`NSIS installer is unexpectedly small: ${size}`)
      }
    }
  }

  for (const file of [
    path.join(outputDir, 'builder-effective-config.yaml'),
    path.join(resourcesDir, 'app-update.yml'),
  ]) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (/\b(?:token|password|secret|GH_TOKEN|NODE_AUTH_TOKEN)\b/i.test(text)) {
      problems.push(`publishing credentials may have leaked into ${path.basename(file)}`)
    }
  }

  return [...new Set(problems)]
}

/**
 * @param {{
 *   desktopRoot?: string;
 *   outputDir?: string;
 *   target?: 'dir' | 'nsis' | 'mac' | 'linux';
 *   verify?: typeof verifyPackage;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  desktopRoot = DESKTOP_ROOT,
  outputDir = DEFAULT_OUTPUT_DIR,
  target = process.argv.includes('--mac')
    ? 'mac'
    : process.argv.includes('--linux')
      ? 'linux'
      : process.argv.includes('--nsis')
        ? 'nsis'
        : 'dir',
  verify = verifyPackage,
} = {}) {
  const problems = await verify({ desktopRoot, outputDir, target })
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify: ${problem}`)
    return 1
  }
  const labels = {
    dir: 'unpacked application',
    nsis: 'installer',
    mac: 'DMG and ZIP',
    linux: 'AppImage and deb',
  }
  console.log(`verify: ${labels[target]} passed`)
  return 0
}

/* v8 ignore start -- CLI bootstrap is executed by `pnpm package:verify`, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
/* v8 ignore stop */
