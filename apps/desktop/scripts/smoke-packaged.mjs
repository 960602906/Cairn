// @ts-check
/**
 * 已打包应用冒烟（M5-02）：启动 `win-unpacked/Cairn.exe`，在临时数据目录中完成窗口、preload、
 * IPC、Agent 宿主、SQLite、ripgrep、技能与 koffi Job Object 检查。任何失败都阻止打包通过。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkPackagedResult,
  packagedApp,
  packagedArguments,
  PACKAGED_SMOKE_TIMEOUT_MS,
  smokeEnvironment,
  temporaryUserData,
} from './packaged-app.mjs'
import { verifyBundledGit } from './bundled-git.mjs'

/**
 * @param {{
 *   outputDir?: string;
 *   spawnProcess?: typeof spawn;
 *   timeoutMs?: number;
 *   platform?: NodeJS.Platform;
 *   log?: (line: string) => void;
 *   locateApp?: typeof packagedApp;
 *   createUserData?: typeof temporaryUserData;
 *   checkResult?: typeof checkPackagedResult;
 *   verifyGit?: typeof verifyBundledGit;
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function smokePackaged({
  outputDir,
  spawnProcess = spawn,
  timeoutMs = PACKAGED_SMOKE_TIMEOUT_MS,
  platform = process.platform,
  log = (line) => process.stdout.write(`${line}\n`),
  locateApp = packagedApp,
  createUserData = temporaryUserData,
  checkResult = checkPackagedResult,
  verifyGit = verifyBundledGit,
} = {}) {
  const app = locateApp(outputDir === undefined ? {} : { outputDir })
  /** @type {string[]} */
  const gitProblems = []
  try {
    const git = verifyGit(path.join(app.directory, 'resources/git'))
    log(`bundled git: ${git.version}`)
  } catch (error) {
    gitProblems.push(
      `bundled MinGit failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const userData = createUserData()
  try {
    return await new Promise((resolve) => {
      const child = spawnProcess(app.executable, packagedArguments(platform), {
        cwd: app.directory,
        env: smokeEnvironment({ userData: userData.path }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        output += String(chunk)
      })
      const timer = setTimeout(() => {
        child.kill()
      }, timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve([`cannot start packaged application: ${error.message}`])
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (output.trim() !== '') log(output.trimEnd())
        resolve([
          ...gitProblems,
          ...checkResult({
            output,
            exitCode: code,
            signal,
            userData: userData.path,
            platform,
          }),
        ])
      })
    })
  } finally {
    userData.cleanup()
  }
}

/**
 * CLI 入口；单独导出以便测试退出码与输出。
 * @param {{
 *   run?: typeof smokePackaged;
 *   error?: (line: string) => void;
 *   print?: (line: string) => void;
 *   setExitCode?: (code: number) => void;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runCli({
  run = smokePackaged,
  error = (line) => console.error(line),
  print = (line) => console.log(line),
  setExitCode = (code) => {
    process.exitCode = code
  },
} = {}) {
  const problems = await run()
  if (problems.length > 0) {
    for (const problem of problems) error(`smoke:packaged: ${problem}`)
    setExitCode(1)
    return 1
  }
  print('smoke:packaged: passed')
  setExitCode(0)
  return 0
}

/* v8 ignore start -- CLI bootstrap is executed by `pnpm smoke:packaged`, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
/* v8 ignore stop */
