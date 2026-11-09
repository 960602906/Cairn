// @ts-check
/**
 * 已安装应用冒烟（M5-02，ADR-0035）。
 *
 * 把 NSIS 安装包静默安装到临时目录，然后验证：
 * - 主程序、卸载程序、asar、原生模块和 skills 的实际安装布局；
 * - 桌面/开始菜单快捷方式与 HKCU 卸载项；
 * - 已安装程序的完整冒烟（窗口、preload、IPC、SQLite、ripgrep、koffi、skills、Agent 宿主）；
 * - 安装目录中的 ripgrep 能在临时项目中执行一次真实命令；
 * - 静默卸载后程序、快捷方式与注册表项消失，而用户数据目录仍然保留。
 *
 * 只支持 Windows；安装与用户数据始终使用临时目录，不触碰 `%APPDATA%\Cairn`。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkPackagedResult,
  packagedArguments,
  PACKAGED_SMOKE_TIMEOUT_MS,
  smokeEnvironment,
} from './packaged-app.mjs'

export const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
export const DEFAULT_OUTPUT_DIR = path.join(DESKTOP_ROOT, 'dist')
export const INSTALL_TIMEOUT_MS = 180_000
export const UNINSTALL_TIMEOUT_MS = 60_000
export const PRODUCT_NAME = 'Cairn'

/**
 * @param {{ desktopRoot?: string }} [options]
 * @returns {string}
 */
export function readVersion({ desktopRoot = DESKTOP_ROOT } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('apps/desktop/package.json is missing version')
  }
  return manifest.version
}

/**
 * @param {{ desktopRoot?: string; outputDir?: string; version?: string }} [options]
 * @returns {string}
 */
export function installerPath({
  desktopRoot = DESKTOP_ROOT,
  outputDir,
  version = readVersion({ desktopRoot }),
} = {}) {
  return path.join(
    outputDir ?? path.join(desktopRoot, 'dist'),
    `${PRODUCT_NAME}-${version}-x64-setup.exe`,
  )
}

/**
 * @param {string} installDir
 * @returns {string[]}
 */
export function installerArguments(installDir) {
  if (!path.isAbsolute(installDir)) throw new Error('NSIS install directory must be absolute')
  // NSIS 要求 /D 放在最后，且安装目录中不能有引号。
  return ['/S', `/D=${installDir}`]
}

/**
 * @returns {string[]}
 */
export function uninstallerArguments() {
  return ['/S', '/currentuser']
}

/**
 * @param {{
 *   installDir: string;
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 * }} options
 * @returns {{ executable: string; uninstaller: string; shortcuts: string[]; resources: string }}
 */
export function installedArtifacts({
  installDir,
  env = process.env,
  home = env['USERPROFILE'] ?? homedir(),
}) {
  const appData = env['APPDATA'] ?? path.join(home, 'AppData/Roaming')
  return {
    executable: path.join(installDir, `${PRODUCT_NAME}.exe`),
    uninstaller: path.join(installDir, `Uninstall ${PRODUCT_NAME}.exe`),
    shortcuts: [
      path.join(home, 'Desktop', `${PRODUCT_NAME}.lnk`),
      path.join(appData, 'Microsoft/Windows/Start Menu/Programs', `${PRODUCT_NAME}.lnk`),
    ],
    resources: path.join(installDir, 'resources'),
  }
}

/**
 * @param {{
 *   installDir: string;
 *   version: string;
 *   registryOutput: string;
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   exists?: (file: string) => boolean;
 * }} options
 * @returns {string[]}
 */
export function checkInstalledLayout({
  installDir,
  version,
  registryOutput,
  env = process.env,
  home,
  exists = existsSync,
}) {
  const artifacts = installedArtifacts({
    installDir,
    env,
    ...(home === undefined ? {} : { home }),
  })
  const problems = []
  for (const { label, file } of [
    { label: 'main executable', file: artifacts.executable },
    { label: 'uninstaller', file: artifacts.uninstaller },
    { label: 'app.asar', file: path.join(artifacts.resources, 'app.asar') },
    {
      label: 'asarUnpack ripgrep',
      file: path.join(artifacts.resources, 'app.asar.unpacked/out/bin/rg.exe'),
    },
    {
      label: 'built-in skills',
      file: path.join(artifacts.resources, 'skills/example/SKILL.md'),
    },
  ]) {
    if (!exists(file)) problems.push(`installed app is missing ${label}: ${file}`)
  }
  for (const shortcut of artifacts.shortcuts) {
    if (!exists(shortcut)) problems.push(`installed app is missing shortcut: ${shortcut}`)
  }
  if (!registryOutput.includes(`${PRODUCT_NAME} ${version}`)) {
    problems.push(`uninstall registry entry does not contain ${PRODUCT_NAME} ${version}`)
  }
  if (!registryOutput.includes(installDir)) {
    problems.push('uninstall registry entry does not point at the temporary install directory')
  }
  return problems
}

/**
 * @param {{
 *   file: string;
 *   args?: readonly string[];
 *   env?: NodeJS.ProcessEnv;
 *   timeoutMs?: number;
 *   spawnProcess?: typeof spawn;
 * }} options
 * @returns {Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; error?: string; timedOut: boolean }>}
 */
export function runProcess({
  file,
  args = [],
  env = process.env,
  timeoutMs = INSTALL_TIMEOUT_MS,
  spawnProcess = spawn,
}) {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    const child = spawnProcess(file, [...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    /** @param {{ code: number | null; signal: NodeJS.Signals | null; error?: string }} result */
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, output, timedOut })
    }
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('error', (error) => finish({ code: null, signal: null, error: error.message }))
    child.on('exit', (code, signal) => finish({ code, signal }))
  })
}

/**
 * @param {{
 *   installDir: string;
 *   runner?: typeof spawnSync;
 * }} options
 * @returns {string}
 */
export function queryUninstallRegistry({ installDir, runner = spawnSync }) {
  const result = runner(
    'reg.exe',
    [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s',
      '/f',
      PRODUCT_NAME,
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return output.includes(installDir) ? output : ''
}

/**
 * @param {string} file
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(file, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return predicate()
}

/**
 * @param {{
 *   installer?: string;
 *   desktopRoot?: string;
 *   platform?: NodeJS.Platform;
 *   spawnProcess?: typeof spawn;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function smokeInstalled({
  installer,
  desktopRoot = DESKTOP_ROOT,
  platform = process.platform,
  spawnProcess = spawn,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (platform !== 'win32') {
    return ['installed-app smoke supports Windows only (ADR-0035)']
  }
  const version = readVersion({ desktopRoot })
  const installerFile = installer ?? installerPath({ desktopRoot })
  const problems = []
  if (!existsSync(installerFile)) {
    return [`NSIS installer was not found: ${installerFile}`]
  }
  const workRoot = mkdtempSync(path.join(tmpdir(), 'cairn-installed-smoke-'))
  const installDir = path.join(workRoot, 'app')
  const userData = path.join(workRoot, 'data')
  mkdirSync(userData, { recursive: true })
  try {
    log(`installed: installing ${installerFile}`)
    const install = await runProcess({
      file: installerFile,
      args: installerArguments(installDir),
      timeoutMs: INSTALL_TIMEOUT_MS,
      spawnProcess,
    })
    if (install.timedOut) problems.push('NSIS installer timed out')
    if (install.error !== undefined) {
      problems.push(`cannot start NSIS installer: ${install.error}`)
    } else if (install.code !== 0) {
      problems.push(`NSIS installer exited with ${String(install.code)} (${install.signal})`)
    }
    if (!existsSync(path.join(installDir, `${PRODUCT_NAME}.exe`))) {
      problems.push('NSIS installer did not create the installed executable')
      return problems
    }

    const artifacts = installedArtifacts({ installDir })
    problems.push(
      ...checkInstalledLayout({
        installDir,
        version,
        registryOutput: queryUninstallRegistry({ installDir }),
      }),
    )

    const workspace = path.join(workRoot, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(path.join(workspace, 'installed-command.txt'), 'cairn-installed-command-marker\n')
    const command = await runProcess({
      file: path.join(artifacts.resources, 'app.asar.unpacked/out/bin/rg.exe'),
      args: [
        '--fixed-strings',
        '--files-with-matches',
        'cairn-installed-command-marker',
        workspace,
      ],
      timeoutMs: 30_000,
      spawnProcess,
    })
    if (command.code !== 0 || !command.output.includes('installed-command.txt')) {
      problems.push(`installed ripgrep command failed: ${command.output.trim()}`)
    }

    log('installed: running application smoke checks')
    const application = await runProcess({
      file: artifacts.executable,
      args: packagedArguments(platform),
      env: smokeEnvironment({ userData }),
      timeoutMs: PACKAGED_SMOKE_TIMEOUT_MS,
      spawnProcess,
    })
    if (application.timedOut) problems.push('installed application smoke timed out')
    if (application.output.trim() !== '') log(application.output.trimEnd())
    problems.push(
      ...checkPackagedResult({
        output: application.output,
        exitCode: application.code,
        signal: application.signal,
        userData,
        platform,
      }),
    )

    log('installed: uninstalling')
    const uninstall = await runProcess({
      file: artifacts.uninstaller,
      args: uninstallerArguments(),
      timeoutMs: UNINSTALL_TIMEOUT_MS,
      spawnProcess,
    })
    if (uninstall.timedOut) problems.push('NSIS uninstaller timed out')
    if (uninstall.error !== undefined) {
      problems.push(`cannot start NSIS uninstaller: ${uninstall.error}`)
    } else if (uninstall.code !== 0) {
      problems.push(`NSIS uninstaller exited with ${String(uninstall.code)} (${uninstall.signal})`)
    }

    const removed = await waitFor('uninstall', () => {
      const remainingShortcuts = artifacts.shortcuts.filter((shortcut) => existsSync(shortcut))
      return (
        !existsSync(installDir) &&
        remainingShortcuts.length === 0 &&
        queryUninstallRegistry({ installDir }) === ''
      )
    })
    if (!removed) problems.push('uninstall did not remove files, shortcuts and registry entry')
    if (!existsSync(path.join(userData, 'data/cairn.db'))) {
      problems.push('uninstall removed the user data directory')
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return [...new Set(problems)]
}

/**
 * @param {{
 *   run?: typeof smokeInstalled;
 *   error?: (line: string) => void;
 *   print?: (line: string) => void;
 *   setExitCode?: (code: number) => void;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runCli({
  run = smokeInstalled,
  error = (line) => console.error(line),
  print = (line) => console.log(line),
  setExitCode = (code) => {
    process.exitCode = code
  },
} = {}) {
  const problems = await run()
  if (problems.length > 0) {
    for (const problem of problems) error(`smoke:installed: ${problem}`)
    setExitCode(1)
    return 1
  }
  print('smoke:installed: passed')
  setExitCode(0)
  return 0
}

/* v8 ignore start -- CLI bootstrap is executed by `pnpm smoke:installed`, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
/* v8 ignore stop */
