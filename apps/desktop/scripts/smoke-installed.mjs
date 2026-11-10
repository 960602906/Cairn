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
 * - 可选的重装验收（M5-10）：卸载前写入设置标记，重装后再次冒烟，并确认设置与数据仍在；
 *   安装目录与数据目录可由调用方指定，用于中文/长路径与最小 PATH 的干净机器模拟。
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
import { verifyBundledGit } from './bundled-git.mjs'
import { readSigningConfig, verifyReleaseSignatures } from '@cairn/release-tools'

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
 * 解码控制台程序的原始输出。`reg.exe` 等 Win32 程序写到管道时使用系统 ANSI 代码页
 * （中文系统为 GBK），先按严格 UTF-8 解码，失败后再按 GBK；两者都不可用时退回替换解码。
 * @param {string | Uint8Array | null | undefined} value
 * @returns {string}
 */
export function decodeConsoleOutput(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    try {
      return new TextDecoder('gbk').decode(value)
    } catch {
      return new TextDecoder().decode(value)
    }
  }
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
    // 必须拿到原始字节：中文安装路径在 ANSI 代码页下不是合法 UTF-8。
    { encoding: 'buffer', timeout: 15_000, windowsHide: true },
  )
  const output = `${decodeConsoleOutput(result.stdout)}${decodeConsoleOutput(result.stderr)}`
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
 *   verifyGit?: typeof verifyBundledGit;
 *   verifySignatures?: typeof verifyReleaseSignatures;
 *   env?: Readonly<Record<string, string | undefined>>;
 *   appEnv?: Readonly<Record<string, string>>;
 *   workRoot?: string;
 *   installDir?: string;
 *   userData?: string;
 *   reinstall?: boolean;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function smokeInstalled({
  installer,
  desktopRoot = DESKTOP_ROOT,
  platform = process.platform,
  spawnProcess = spawn,
  verifyGit = verifyBundledGit,
  verifySignatures = verifyReleaseSignatures,
  env = process.env,
  appEnv = {},
  workRoot: requestedWorkRoot,
  installDir: requestedInstallDir,
  userData: requestedUserData,
  reinstall = false,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (platform !== 'win32') {
    return ['installed-app smoke supports Windows only (ADR-0035)']
  }
  const version = readVersion({ desktopRoot })
  const installerFile = installer ?? installerPath({ desktopRoot })
  /** @type {string[]} */
  const problems = []
  if (!existsSync(installerFile)) {
    return [`NSIS installer was not found: ${installerFile}`]
  }
  const workRoot = requestedWorkRoot ?? mkdtempSync(path.join(tmpdir(), 'cairn-installed-smoke-'))
  const ownsWorkRoot = requestedWorkRoot === undefined
  const installDir = requestedInstallDir ?? path.join(workRoot, 'app')
  const userData = requestedUserData ?? path.join(workRoot, 'data')
  const marker = path.join(userData, 'settings.json')
  const passes = reinstall ? 2 : 1
  try {
    mkdirSync(userData, { recursive: true })
    for (let pass = 0; pass < passes; pass += 1) {
      const phase = pass === 0 ? 'installed' : 'reinstalled'
      /** 重装阶段的问题带前缀，便于在输出里区分两次安装。 */
      /** @param {string} problem */
      const report = (problem) => problems.push(pass === 0 ? problem : `reinstall: ${problem}`)

      log(`${phase}: installing ${installerFile}`)
      const install = await runProcess({
        file: installerFile,
        args: installerArguments(installDir),
        timeoutMs: INSTALL_TIMEOUT_MS,
        spawnProcess,
      })
      if (install.timedOut) report('NSIS installer timed out')
      if (install.error !== undefined) {
        report(`cannot start NSIS installer: ${install.error}`)
      } else if (install.code !== 0) {
        report(`NSIS installer exited with ${String(install.code)} (${install.signal})`)
      }
      if (!existsSync(path.join(installDir, `${PRODUCT_NAME}.exe`))) {
        report('NSIS installer did not create the installed executable')
        return problems
      }

      const artifacts = installedArtifacts({ installDir })
      for (const problem of checkInstalledLayout({
        installDir,
        version,
        registryOutput: queryUninstallRegistry({ installDir }),
      })) {
        report(problem)
      }

      // 发布构建在安装后校验主程序与卸载程序；普通 CI 不设置该变量，避免依赖 Windows SDK。
      // 重装使用同一批文件，签名只在第一次安装后校验，避免重复调用 signtool。
      if (pass === 0 && env['CAIRN_VERIFY_SIGNATURES'] === '1') {
        log('installed: verifying Authenticode signatures')
        for (const problem of verifySignatures({
          distDir: path.dirname(installerFile),
          version,
          installedDir: installDir,
          config: readSigningConfig(env),
          platform,
        })) {
          report(problem)
        }
      }

      // 随包 MinGit（M5-03）：安装目录里的裁剪产物必须能真实执行 Git 操作。
      try {
        const git = verifyGit(path.join(artifacts.resources, 'git'))
        log(`${phase}: bundled git ${git.version}`)
      } catch (error) {
        report(
          `installed bundled MinGit failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const workspace = path.join(workRoot, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(
        path.join(workspace, 'installed-command.txt'),
        'cairn-installed-command-marker\n',
      )
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
        report(`installed ripgrep command failed: ${command.output.trim()}`)
      }

      log(`${phase}: running application smoke checks`)
      const application = await runProcess({
        file: artifacts.executable,
        args: packagedArguments(platform),
        env: { ...smokeEnvironment({ userData }), ...appEnv },
        timeoutMs: PACKAGED_SMOKE_TIMEOUT_MS,
        spawnProcess,
      })
      if (application.timedOut) report('installed application smoke timed out')
      if (application.output.trim() !== '') log(application.output.trimEnd())
      for (const problem of checkPackagedResult({
        output: application.output,
        exitCode: application.code,
        signal: application.signal,
        userData,
        platform,
      })) {
        report(problem)
      }

      // 卸载前记录用户设置；重装后必须原样读回（M5-10 的“重装恢复数据”）。
      if (pass === 0 && reinstall) {
        writeFileSync(
          marker,
          `${JSON.stringify({ locale: 'zh-CN', onboardingSeen: true }, null, 2)}\n`,
        )
      }

      log(`${phase}: uninstalling`)
      const uninstall = await runProcess({
        file: artifacts.uninstaller,
        args: uninstallerArguments(),
        timeoutMs: UNINSTALL_TIMEOUT_MS,
        spawnProcess,
      })
      if (uninstall.timedOut) report('NSIS uninstaller timed out')
      if (uninstall.error !== undefined) {
        report(`cannot start NSIS uninstaller: ${uninstall.error}`)
      } else if (uninstall.code !== 0) {
        report(`NSIS uninstaller exited with ${String(uninstall.code)} (${uninstall.signal})`)
      }

      const removed = await waitFor('uninstall', () => {
        const remainingShortcuts = artifacts.shortcuts.filter((shortcut) => existsSync(shortcut))
        return (
          !existsSync(installDir) &&
          remainingShortcuts.length === 0 &&
          queryUninstallRegistry({ installDir }) === ''
        )
      })
      if (!removed) report('uninstall did not remove files, shortcuts and registry entry')
      if (!existsSync(path.join(userData, 'data/cairn.db'))) {
        report('uninstall removed the user data directory')
      }

      if (pass === passes - 1 && reinstall) {
        const saved = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : undefined
        if (saved?.locale !== 'zh-CN' || saved?.onboardingSeen !== true) {
          report('reinstall did not keep the saved user settings')
        }
      }
    }
  } finally {
    if (ownsWorkRoot) {
      rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
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
