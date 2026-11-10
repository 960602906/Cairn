// @ts-check
/**
 * 安装级发布验收（M5-10）。
 *
 * 在真实的 NSIS 安装包上模拟“干净机器上的普通用户”：
 * - 安装目录与用户数据目录含中文、空格与较长层级，覆盖非 ASCII 与长路径；
 * - 应用进程的 `PATH` 只保留系统目录，模拟没有 Git / Node / 开发工具的机器；
 * - 安装 → 冒烟 → 卸载（数据保留）→ 重装 → 冒烟 → 设置仍可读回 → 卸载。
 *
 * 这不替代 Windows 10/11 干净 VM、标准用户账户与 SmartScreen 的人工矩阵，
 * 但能在任意 Windows 开发机或 CI 上重复验证安装、卸载与重装路径。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { smokeInstalled } from './smoke-installed.mjs'

/** 中文、空格与长层级的安装/数据目录片段。 */
export const ACCEPTANCE_DIRECTORIES = {
  install: ['验收 安装 目录', '普通 用户', '一个用于验收安装流程的较长中文目录名称'],
  data: ['用户 数据 目录', '一个用于验收重装恢复的中文数据目录'],
}

/**
 * 只保留系统目录的 `PATH`：没有 Git、Node 或其他开发工具。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function systemOnlyPath(env = process.env) {
  const root = env['SystemRoot'] ?? 'C:\\Windows'
  return [
    path.join(root, 'System32'),
    root,
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

/**
 * @param {{
 *   run?: typeof smokeInstalled;
 *   env?: NodeJS.ProcessEnv;
 *   createWorkRoot?: () => string;
 *   removeWorkRoot?: (directory: string) => void;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function installedAcceptance({
  run = smokeInstalled,
  env = process.env,
  createWorkRoot = () => mkdtempSync(path.join(tmpdir(), 'cairn-acceptance-installed-')),
  removeWorkRoot = (directory) =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const workRoot = createWorkRoot()
  try {
    const installDir = path.join(workRoot, ...ACCEPTANCE_DIRECTORIES.install)
    const userData = path.join(workRoot, ...ACCEPTANCE_DIRECTORIES.data)
    log(`acceptance: install ${installDir}`)
    log(`acceptance: user data ${userData}`)
    return await run({
      workRoot,
      installDir,
      userData,
      reinstall: true,
      appEnv: { PATH: systemOnlyPath(env) },
      env,
      log,
    })
  } finally {
    removeWorkRoot(workRoot)
  }
}

/**
 * @param {{
 *   run?: typeof installedAcceptance;
 *   error?: (line: string) => void;
 *   print?: (line: string) => void;
 *   setExitCode?: (code: number) => void;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runCli({
  run = installedAcceptance,
  error = (line) => console.error(line),
  print = (line) => console.log(line),
  setExitCode = (code) => {
    process.exitCode = code
  },
} = {}) {
  const problems = await run()
  if (problems.length > 0) {
    for (const problem of problems) error(`acceptance:installed: ${problem}`)
    setExitCode(1)
    return 1
  }
  print('acceptance:installed: passed')
  setExitCode(0)
  return 0
}

/* v8 ignore start -- CLI bootstrap is executed by `pnpm acceptance:installed`, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
/* v8 ignore stop */
