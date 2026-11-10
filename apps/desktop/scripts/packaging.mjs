// @ts-check
/**
 * Windows 打包（M5-02，ADR-0035）。
 *
 * electron-builder 不能直接把 pnpm 工作区作为项目目录：工作区链接与虚拟 store 会让 `app.asar`
 * 膨胀到约 145 MB。这里先把构建产物、技能资源与“实际被主进程加载的外部依赖”复制到扁平 staging，
 * 在 staging 中安装生产依赖，再交给 electron-builder。
 *
 * 运行时依赖不手工维护：扫描 `out/main` 与 `out/preload` 中实际出现的非 Node 内建导入，并与
 * `apps/desktop/package.json` 的 dependencies 对照。遗漏会在这里失败，而不是等到安装后启动才发现。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { init as initLexer, parse as parseImports } from 'es-module-lexer'
import { readSigningConfig, signingBuilderArgs, signingEnvironment } from '@cairn/release-tools'
import { verifyPackage } from './verify-package.mjs'

const THIS_DIR = import.meta.dirname
export const DESKTOP_ROOT = path.resolve(THIS_DIR, '..')
export const DEFAULT_STAGE_DIR = path.join(DESKTOP_ROOT, '.package/app')
export const DEFAULT_OUTPUT_DIR = path.join(DESKTOP_ROOT, 'dist')
export const BUILDER_CONFIG = path.join(DESKTOP_ROOT, 'electron-builder.yml')
export const SCAN_DIRECTORIES = ['out/main', 'out/preload']

/** 主进程导入但不来自 npm 的模块。 */
const NON_PACKAGE_MODULES = new Set(['electron'])

/**
 * 把导入说明符映射到 npm 包名；相对路径、绝对路径、URL、Node 内建模块与 Electron 返回 undefined。
 * @param {string} specifier
 * @returns {string | undefined}
 */
export function packageNameOf(specifier) {
  const name = specifier.trim()
  if (name === '' || name.startsWith('.') || name.startsWith('/') || name.includes('://')) {
    return undefined
  }
  if (path.isAbsolute(name) || isBuiltin(name) || NON_PACKAGE_MODULES.has(name)) return undefined
  const parts = name.split('/')
  if (name.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0]
}

let lexerReady

/**
 * 从构建后的 JavaScript 中提取静态与动态导入说明符。使用语法分析而不是正则，
 * 避免把注释里的 `require('debug')` 示例当成真实依赖。
 * @param {string} source
 * @returns {Promise<string[]>}
 */
export async function extractModuleSpecifiers(source) {
  lexerReady ??= initLexer
  await lexerReady
  const [imports] = parseImports(source)
  return imports.flatMap((entry) => (entry.n === undefined ? [] : [entry.n]))
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function javascriptFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:c?js|mjs)$/i.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

/**
 * 计算必须随安装包分发的直接生产依赖。
 * @param {{
 *   desktopRoot?: string;
 *   dependencies: Readonly<Record<string, string>>;
 *   scanDirectories?: readonly string[];
 * }} options
 * @returns {Promise<{ dependencies: Record<string, string>; modules: string[] }>}
 */
export async function resolveRuntimeDependencies({
  desktopRoot = DESKTOP_ROOT,
  dependencies,
  scanDirectories = SCAN_DIRECTORIES,
}) {
  const required = new Set()
  for (const relative of scanDirectories) {
    for (const file of javascriptFiles(path.join(desktopRoot, relative))) {
      for (const specifier of await extractModuleSpecifiers(readFileSync(file, 'utf8'))) {
        const name = packageNameOf(specifier)
        if (name !== undefined) required.add(name)
      }
    }
  }
  const missing = [...required].filter((name) => !(name in dependencies))
  if (missing.length > 0) {
    throw new Error(
      `runtime imports are missing from apps/desktop/package.json dependencies: ${missing.join(', ')}`,
    )
  }
  const selected = Object.fromEntries(
    [...required].sort().map((name) => [name, /** @type {string} */ (dependencies[name])]),
  )
  return { dependencies: selected, modules: Object.keys(selected).sort() }
}

/**
 * 生成 staging 的应用清单：只保留运行时字段、直接生产依赖与 electron 版本。
 * @param {{
 *   manifest: Record<string, unknown>;
 *   dependencies: Readonly<Record<string, string>>;
 * }} options
 * @returns {Record<string, unknown>}
 */
export function createStagedManifest({ manifest, dependencies }) {
  for (const field of ['name', 'version', 'type', 'main']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      throw new Error(`apps/desktop/package.json is missing ${field}`)
    }
  }
  const electron = /** @type {Record<string, unknown> | undefined} */ (
    manifest['devDependencies']
  )?.['electron']
  if (typeof electron !== 'string' || electron === '') {
    throw new Error('apps/desktop/package.json is missing the electron devDependency')
  }
  if (Object.keys(dependencies).length === 0) {
    throw new Error('no runtime dependencies were discovered in the built main process')
  }
  return {
    name: manifest['name'],
    version: manifest['version'],
    productName: manifest['productName'] ?? 'Cairn',
    description: manifest['description'] ?? 'Cairn desktop application',
    author: manifest['author'] ?? 'Cairn contributors',
    copyright: manifest['copyright'] ?? '',
    private: true,
    type: manifest['type'],
    main: manifest['main'],
    dependencies,
    devDependencies: { electron },
    // koffi 的安装脚本把对应平台的预编译 Node-API 二进制放到包内；仅允许这一项。
    allowScripts: { koffi: true },
  }
}

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function readJsonFile(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * 复制构建产物到独立 staging，并写入裁剪后的 package.json。
 * @param {{
 *   desktopRoot?: string;
 *   stageDir?: string;
 *   dependencies: Readonly<Record<string, string>>;
 * }} options
 * @returns {{ manifest: Record<string, unknown>; modules: string[] }}
 */
export function stageApplication({
  desktopRoot = DESKTOP_ROOT,
  stageDir = DEFAULT_STAGE_DIR,
  dependencies,
}) {
  const outDir = path.join(desktopRoot, 'out')
  for (const required of [
    'main/index.js',
    'main/startup.js',
    'main/agent-host.js',
    'preload/index.cjs',
    'renderer/index.html',
    'bin/rg.exe',
    'build-info.json',
    'THIRD_PARTY_NOTICES.txt',
  ]) {
    if (!existsSync(path.join(outDir, required))) {
      throw new Error(`apps/desktop/out/${required} is missing; run \`pnpm build\` first`)
    }
  }
  const skills = path.join(desktopRoot, 'resources/skills/example/SKILL.md')
  if (!existsSync(skills)) throw new Error(`built-in skills are missing: ${skills}`)

  const desktopManifest = readJsonFile(path.join(desktopRoot, 'package.json'))
  const stagedManifest = createStagedManifest({ manifest: desktopManifest, dependencies })
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  cpSync(outDir, path.join(stageDir, 'out'), { recursive: true })
  cpSync(path.join(desktopRoot, 'resources'), path.join(stageDir, 'resources'), {
    recursive: true,
  })
  cpSync(path.join(desktopRoot, 'build'), path.join(stageDir, 'build'), { recursive: true })
  writeFileSync(path.join(stageDir, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`)
  // 隔离开发机的 ~/.npmrc（可能包含 authToken 或 npm 11 不接受的项目级 allow-scripts）。
  writeFileSync(
    path.join(stageDir, '.npmrc'),
    'registry=https://registry.npmjs.org/\nfund=false\naudit=false\n',
  )
  return { manifest: stagedManifest, modules: Object.keys(dependencies).sort() }
}

/**
 * 在 staging 中执行扁平生产依赖安装。
 * @param {{
 *   stageDir?: string;
 *   runner?: typeof spawnSync;
 *   env?: NodeJS.ProcessEnv;
 *   platform?: NodeJS.Platform;
 * }} [options]
 */
export function installProductionDependencies({
  stageDir = DEFAULT_STAGE_DIR,
  runner = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm'
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...env,
    NPM_CONFIG_USERCONFIG: path.join(stageDir, '.npmrc'),
    npm_config_userconfig: path.join(stageDir, '.npmrc'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  }
  // pnpm 可能把用户 npmrc 的 allow-scripts 作为环境变量传下来；npm 11 在项目安装中拒绝该来源。
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') delete childEnv[key]
  }
  const result = runner(
    npm,
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'],
    {
      cwd: stageDir,
      env: childEnv,
      stdio: 'inherit',
      windowsHide: true,
      shell: platform === 'win32',
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `npm install in the staging directory failed with ${result.status ?? result.signal}`,
    )
  }
}

/**
 * 删除 staging 中与目标平台无关的原生预编译文件和 better-sqlite3 的 C 源码。
 * 安装包只支持 Windows x64（ADR-0035），保留其他平台只会增加体积与扫描面。
 * @param {{
 *   stageDir?: string;
 *   platform?: NodeJS.Platform;
 *   arch?: NodeJS.Architecture;
 * }} [options]
 * @returns {{ removed: string[]; kept: string }}
 */
export function pruneStagedDependencies({
  stageDir = DEFAULT_STAGE_DIR,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const prebuilds = path.join(stageDir, 'node_modules/better-sqlite3/prebuilds')
  const expected = `${platform}-${arch}.node`
  const removed = []
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name === expected) continue
      rmSync(path.join(prebuilds, entry.name), { force: true })
      removed.push(entry.name)
    }
  }
  const sqliteDeps = path.join(stageDir, 'node_modules/better-sqlite3/deps')
  if (existsSync(sqliteDeps)) {
    rmSync(sqliteDeps, { recursive: true, force: true })
    removed.push('better-sqlite3/deps')
  }
  return { removed, kept: expected }
}

/**
 * @param {string} desktopRoot
 * @returns {string}
 */
export function electronBuilderCli(desktopRoot = DESKTOP_ROOT) {
  const require = createRequire(path.join(desktopRoot, 'package.json'))
  return path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js')
}

/**
 * 运行 electron-builder；普通构建永远不发布。
 * @param {{
 *   target: 'dir' | 'nsis';
 *   desktopRoot?: string;
 *   stageDir?: string;
 *   outputDir?: string;
 *   runner?: typeof spawnSync;
 *   env?: NodeJS.ProcessEnv;
 *   platform?: NodeJS.Platform;
 *   signing?: ReturnType<typeof readSigningConfig>;
 * }} options
 */
export function runElectronBuilder({
  target,
  desktopRoot = DESKTOP_ROOT,
  stageDir = DEFAULT_STAGE_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  runner = spawnSync,
  env = process.env,
  platform = process.platform,
  signing = readSigningConfig(env),
}) {
  if (platform !== 'win32') {
    throw new Error('M5-02 packaging supports Windows x64 only (ADR-0035)')
  }
  const args = [
    electronBuilderCli(desktopRoot),
    '--projectDir',
    stageDir,
    '--config',
    BUILDER_CONFIG,
    '--config.directories.output',
    outputDir,
    '--publish',
    'never',
  ]
  args.push(...signingBuilderArgs(signing))
  if (target === 'dir') args.push('--dir')
  else args.push('--win', 'nsis')
  const result = runner(process.execPath, args, {
    cwd: desktopRoot,
    // 签名材料只经环境变量进入子进程，不出现在命令行与构建日志里。
    env: signingEnvironment(signing, env),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`electron-builder failed with ${result.status ?? result.signal}`)
  }
}

/**
 * 写 SHA-256 校验和（`<hex>  <file name>`）。
 * @param {string} file
 * @returns {string} 校验和文件路径
 */
export function writeChecksum(file) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const target = `${file}.sha256`
  writeFileSync(target, `${hash}  ${path.basename(file)}\n`)
  return target
}

/**
 * 解析命令行参数并执行完整打包。
 * @param {{
 *   argv?: readonly string[];
 *   desktopRoot?: string;
 *   stageDir?: string;
 *   outputDir?: string;
 *   install?: typeof installProductionDependencies;
 *   build?: typeof runElectronBuilder;
 *   verify?: typeof verifyPackage;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  argv = process.argv.slice(2),
  desktopRoot = DESKTOP_ROOT,
  stageDir = DEFAULT_STAGE_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  install = installProductionDependencies,
  build = runElectronBuilder,
  verify = verifyPackage,
  log = (line) => console.log(line),
} = {}) {
  const target = argv.includes('--nsis') ? 'nsis' : argv.includes('--dir') ? 'dir' : undefined
  if (target === undefined) {
    throw new Error('usage: packaging.mjs --dir|--nsis')
  }
  const desktopManifest = readJsonFile(path.join(desktopRoot, 'package.json'))
  const dependencies = /** @type {Record<string, string>} */ (desktopManifest['dependencies'] ?? {})
  const runtime = await resolveRuntimeDependencies({ desktopRoot, dependencies })
  log(`package: ${runtime.modules.length} runtime dependencies: ${runtime.modules.join(', ')}`)
  const staged = stageApplication({
    desktopRoot,
    stageDir,
    dependencies: runtime.dependencies,
  })
  log(`package: staged Cairn ${String(staged.manifest['version'])} in ${stageDir}`)
  install({ stageDir })
  const pruned = pruneStagedDependencies({ stageDir })
  log(`package: pruned ${pruned.removed.length} unnecessary native/source entries`)
  build({ target, desktopRoot, stageDir, outputDir })
  if (target === 'nsis') {
    const version = String(staged.manifest['version'])
    const installer = path.join(outputDir, `Cairn-${version}-x64-setup.exe`)
    if (!existsSync(installer)) throw new Error(`NSIS installer was not created: ${installer}`)
    writeChecksum(installer)
  }
  const problems = await verify({ desktopRoot, outputDir, target })
  if (problems.length > 0) {
    for (const problem of problems) console.error(`package: ${problem}`)
    return 1
  }
  log(`package: ${target === 'nsis' ? 'NSIS installer' : 'unpacked application'} verified`)
  return 0
}

/* v8 ignore start -- CLI bootstrap is executed by `pnpm package:*`, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
/* v8 ignore stop */
