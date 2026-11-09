/**
 * 更新包的严格 Authenticode 验证（M5-06，ADR-0036）。
 *
 * `electron-updater` 默认验证器在 PowerShell 执行失败或输出异常时可能放行；这里采用失败关闭：
 * 执行失败、输出无法解析、签名状态不是 Valid、缺少签名者、缺少时间戳或 DN 不匹配都返回错误。
 *
 * 文件名通过环境变量传给 PowerShell，不拼进命令文本；发布者 DN 只在内存中比较。
 */
import { execFile } from 'node:child_process'

export type SignatureVerifier = (
  publisherNames: readonly string[],
  file: string,
) => Promise<string | null>

export interface CommandResult {
  readonly error?: Error | null
  readonly stdout?: string
  readonly stderr?: string
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly timeout: number
    readonly windowsHide: boolean
  },
  callback: (result: CommandResult) => void,
) => void

export interface AuthenticodeVerifierOptions {
  readonly run?: CommandRunner
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

/** PowerShell 只负责读取状态；所有判断都在 Node 里做，避免脚本里的字符串比较被绕过。 */
const AUTHENTICODE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:CAIRN_UPDATE_FILE',
  '$result = [ordered]@{',
  '  status = [string]$signature.Status',
  '  subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }',
  '  thumbprint = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }',
  '  timestamped = $null -ne $signature.TimeStamperCertificate',
  '  path = $signature.Path',
  '}',
  '[Console]::Out.Write(($result | ConvertTo-Json -Compress))',
].join('; ')

interface AuthenticodeOutput {
  readonly status?: unknown
  readonly subject?: unknown
  readonly thumbprint?: unknown
  readonly timestamped?: unknown
  readonly path?: unknown
}

const defaultRunner: CommandRunner = (command, args, options, callback) => {
  execFile(
    command,
    [...args],
    { env: options.env, timeout: options.timeout, windowsHide: options.windowsHide },
    (error, stdout, stderr) => callback({ error, stdout, stderr }),
  )
}

/**
 * 解析 DN 为键值对。支持反斜杠转义与引号；键不区分大小写，值保持原样。
 * 解析失败时返回空 Map（调用方按“不匹配”处理）。
 */
export function parseDistinguishedName(dn: string): Map<string, string> {
  const result = new Map<string, string>()
  let part = ''
  let quoted = false
  const parts: string[] = []
  for (let index = 0; index < dn.length; index += 1) {
    const char = dn[index]!
    if (char === '\\' && index + 1 < dn.length) {
      part += dn[index + 1]
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ',' && !quoted) {
      parts.push(part)
      part = ''
      continue
    }
    part += char
  }
  parts.push(part)
  for (const entry of parts) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator).trim().toUpperCase()
    const value = entry.slice(separator + 1).trim()
    if (key !== '' && value !== '') result.set(key, value)
  }
  return result
}

/** 发布者 DN 必须包含键值对，不能只用 CN。 */
export function isFullDistinguishedName(dn: string): boolean {
  return parseDistinguishedName(dn).size > 0 && dn.includes('=')
}

function matchesPublisher(publisherNames: readonly string[], subject: string): boolean {
  const actual = parseDistinguishedName(subject)
  if (actual.size === 0) return false
  for (const name of publisherNames) {
    const expected = parseDistinguishedName(name)
    let matches = true
    for (const [key, value] of expected) {
      if (actual.get(key) !== value) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

/** 把 PowerShell 输出解析成对象；失败时返回 undefined。 */
export function parseAuthenticodeOutput(text: string): AuthenticodeOutput | undefined {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed === '') return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null ? (value as AuthenticodeOutput) : undefined
  } catch {
    return undefined
  }
}

/**
 * 创建严格验证器。成功返回 null；任何不确定都返回非空错误字符串。
 * 调用方负责在失败后删除下载的临时包。
 */
export function createAuthenticodeVerifier(
  options: AuthenticodeVerifierOptions = {},
): SignatureVerifier {
  const run = options.run ?? defaultRunner
  const timeout = options.timeoutMs ?? 20_000
  const baseEnv = options.env ?? process.env

  return async (publisherNames, file) => {
    if (publisherNames.length === 0) return 'publisher name is not configured'
    for (const name of publisherNames) {
      if (!isFullDistinguishedName(name)) {
        return 'publisher name must be a full distinguished name (CN=..., O=...)'
      }
    }
    if (file.trim() === '') return 'update file path is empty'

    let result: CommandResult
    try {
      result = await new Promise<CommandResult>((resolve) => {
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-InputFormat',
            'None',
            '-Command',
            AUTHENTICODE_SCRIPT,
          ],
          {
            env: { ...baseEnv, CAIRN_UPDATE_FILE: file },
            timeout,
            windowsHide: true,
          },
          resolve,
        )
      })
    } catch (error) {
      return `signature verification could not run: ${String(error)}`
    }

    if (result.error) {
      return `signature verification failed: ${result.error.message}`
    }
    if (result.stderr && result.stderr.trim() !== '') {
      return `signature verification wrote to stderr: ${result.stderr.trim().slice(0, 500)}`
    }
    const output = parseAuthenticodeOutput(result.stdout ?? '')
    if (!output) return 'signature verification returned unparseable output'

    const status = String(output.status ?? '')
    if (status !== 'Valid' && status !== '0') {
      return `signature status is ${status === '' ? 'missing' : status}`
    }
    const subject = typeof output.subject === 'string' ? output.subject : ''
    if (subject === '') return 'signature has no signer certificate subject'
    if (output.timestamped !== true) return 'signature has no trusted timestamp'
    if (typeof output.path === 'string' && output.path !== '' && output.path !== file) {
      // 防止验证器读取的文件与实际下载文件不一致。
      return 'signature verification read a different file'
    }
    if (!matchesPublisher(publisherNames, subject)) {
      return 'signature publisher does not match the configured publisher name'
    }
    return null
  }
}
