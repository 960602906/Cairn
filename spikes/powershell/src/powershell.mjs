// @ts-check
/**
 * 启动 PowerShell 执行一段脚本（ADR-0012 的做法，供各检查项共用）。
 *
 * - `-NoProfile -NonInteractive -EncodedCommand <Base64(UTF-16LE)>`，不经过任何命令行转义。
 * - 包装方式（`wrap`）：
 *   - `raw`：只传用户脚本，不做任何设置（对照组，展示默认行为）；
 *   - `prelude`：前置脚本 + 用户脚本直接拼接；
 *   - `scriptblock`：前置脚本运行后，再把用户脚本（UTF-8 Base64）解码为脚本块点执行。用户脚本有语法错误时，
 *     错误发生在前置脚本之后，错误信息同样按 UTF-8 输出。
 * - 输出按字节收集，由调用方按 UTF-8 解码与比较。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 前置脚本：输出编码统一为 UTF-8（无 BOM），关闭进度条与颜色，文件读写默认 UTF-8。 */
export const PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$__utf8 = New-Object System.Text.UTF8Encoding $false',
  'try { [Console]::OutputEncoding = $__utf8; [Console]::InputEncoding = $__utf8 } catch {}',
  '$OutputEncoding = $__utf8',
  "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
  "if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'PlainText' }",
].join('\n')

/** 结尾：最后一条原生命令失败时，以它的退出码退出（否则 PowerShell 只返回 0 / 1）。 */
export const EPILOGUE =
  'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'

/** @param {string} script */
export const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64')

/**
 * @param {string} script
 * @param {'raw' | 'prelude' | 'scriptblock'} wrap
 * @param {{ epilogue?: boolean }} [options]
 */
export function wrapScript(script, wrap, options = {}) {
  const tail = options.epilogue ? `\n${EPILOGUE}` : ''
  if (wrap === 'raw') return script + tail
  if (wrap === 'prelude') return `${PRELUDE}\n${script}${tail}`
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return (
    [
      PRELUDE,
      `$__script = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`,
      '. ([ScriptBlock]::Create($__script))',
    ].join('\n') + tail
  )
}

/**
 * 可用的 PowerShell：Windows PowerShell 5.1 与 PowerShell 7（如已安装）。
 * @returns {{ id: 'powershell' | 'pwsh', exe: string, version: string }[]}
 */
export function findShells() {
  /** @type {{ id: 'powershell' | 'pwsh', exe: string, version: string }[]} */
  const shells = []
  for (const id of /** @type {const} */ (['powershell', 'pwsh'])) {
    const exe = process.platform === 'win32' ? `${id}.exe` : id
    const probe = spawnSync(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { encoding: 'utf8', windowsHide: true },
    )
    if (probe.status === 0) shells.push({ id, exe, version: probe.stdout.trim() })
  }
  return shells
}

/**
 * @typedef {object} RunOptions
 * @property {'raw' | 'prelude' | 'scriptblock'} [wrap]
 * @property {boolean} [epilogue]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [timeoutMs] 超时后结束进程（只结束 PowerShell 本身；进程树见 tree.mjs）
 * @property {(child: import('node:child_process').ChildProcess) => void} [onSpawn]
 *
 * @typedef {object} RunResult
 * @property {number | null} code
 * @property {Buffer} stdout
 * @property {Buffer} stderr
 * @property {number} ms
 * @property {boolean} timedOut
 * @property {string | undefined} spawnError
 * @property {number} cmdChars 命令行总长（UTF-16 字符）
 */

/**
 * @param {{ exe: string }} shell
 * @param {string} script
 * @param {RunOptions} [options]
 * @returns {Promise<RunResult>}
 */
export function runPowerShell(shell, script, options = {}) {
  const wrapped = wrapScript(script, options.wrap ?? 'prelude', { epilogue: options.epilogue })
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(wrapped)]
  return runProcess(shell.exe, args, options)
}

/**
 * @param {string} exe
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {Promise<RunResult>}
 */
export function runProcess(exe, args, options = {}) {
  const started = performance.now()
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    let timedOut = false
    /** @type {string | undefined} */
    let spawnError
    // 命令行总长（UTF-16 字符），Windows 上限 32767
    const cmdChars = [exe, ...args].reduce((n, a) => n + a.length + 1, 0)
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(exe, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      // 命令行过长时 spawn 同步抛出 ENAMETOOLONG
      const empty = Buffer.alloc(0)
      resolve({
        code: null,
        stdout: empty,
        stderr: empty,
        ms: 0,
        timedOut: false,
        spawnError: String(/** @type {Error} */ (e).message),
        cmdChars,
      })
      return
    }
    // 不支持交互：标准输入立即关闭
    child.stdin?.end()
    child.stdout?.on('data', (b) => out.push(b))
    child.stderr?.on('data', (b) => err.push(b))
    options.onSpawn?.(child)
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill()
          }, options.timeoutMs)
    child.on('error', (e) => {
      spawnError = e.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        ms: Math.round(performance.now() - started),
        timedOut,
        spawnError,
        cmdChars,
      })
    })
  })
}

/** 按 UTF-8 解码并统一换行、去掉首尾空白。 */
export const text = (/** @type {Buffer} */ b) => b.toString('utf8').replace(/\r\n/g, '\n').trim()

/** PowerShell 字符串字面量（单引号）。 */
export const psQuote = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`

export const FIXTURES = path.resolve(import.meta.dirname, 'fixtures')

/** Windows 上可用的 Python（检查原生程序的输出编码），没有时返回 undefined。 */
export function findPython() {
  for (const exe of ['python', 'py']) {
    const probe = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0) return exe
  }
  return undefined
}

export const exists = existsSync
