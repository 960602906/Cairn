// @ts-check
/**
 * Windows 代码签名配置与发布校验（M5-08，ADR-0036）。
 *
 * 签名本身交给 electron-builder 的原生 signtool / Azure Trusted Signing 集成：
 * PFX 与密码只经 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 传给子进程，不写命令行；
 * 云签名只读取环境里的微软凭据链，不接触私钥。构建完成后由本模块用
 * `signtool verify /pa /all /v` 与 PowerShell `Get-AuthenticodeSignature` 双重校验：
 * 状态必须为 Valid、主题必须与配置的完整 DN 完全一致、必须带 RFC 3161 时间戳。
 *
 * 用法：
 * - release workflow 在 `pnpm package:nsis` 前读取配置（`readSigningConfig`）；
 * - 打包后执行 `node scripts/windows-signing.mjs --dist apps/desktop/dist [--installed <dir>]`；
 * - `smoke:installed` 在 `CAIRN_VERIFY_SIGNATURES=1` 时校验安装后的主程序与卸载程序。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SIGNING_MODES = ['none', 'pfx', 'azure']
export const DEFAULT_TIMESTAMP_URL = 'https://timestamp.digicert.com'
export const PRODUCT_NAME = 'Cairn'

/** @typedef {{ mode: 'none' } | { mode: 'pfx'; publisher: string; timestampUrl: string; certificate: string; password: string } | { mode: 'azure'; publisher: string; timestampUrl: string; endpoint: string; account: string; profile: string }} SigningConfig */

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} name
 * @returns {string}
 */
function required(env, name) {
  const value = env[name]?.trim() ?? ''
  if (value === '') throw new Error(`${name} is required when code signing is enabled`)
  return value
}

/**
 * 校验完整证书主题 DN 的基本形状。签名后仍会与证书实际主题逐字比较，这里只拦截明显错误。
 * @param {string} publisher
 * @returns {string}
 */
export function validatePublisher(publisher) {
  const value = publisher.trim()
  if (value === '') throw new Error('publisher DN is required when code signing is enabled')
  if (value.length > 512) throw new Error('publisher DN must be at most 512 characters')
  if (/[\r\n]/.test(value)) throw new Error('publisher DN must be a single line')
  if (!value.includes('=')) {
    throw new Error('publisher must be the full certificate subject DN, not a common name')
  }
  return value
}

/**
 * 从 CI secrets / 环境读取签名配置。未配置签名时返回 `{ mode: 'none' }`。
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {SigningConfig}
 */
export function readSigningConfig(env = process.env) {
  const rawMode = (env['CAIRN_SIGN_MODE']?.trim() ?? 'none').toLowerCase()
  if (!SIGNING_MODES.includes(rawMode)) {
    throw new Error(`CAIRN_SIGN_MODE must be one of ${SIGNING_MODES.join(', ')}`)
  }
  if (rawMode === 'none') return { mode: 'none' }

  const publisher = validatePublisher(env['CAIRN_UPDATE_PUBLISHER'] ?? '')
  const timestampUrl = (env['CAIRN_TIMESTAMP_URL']?.trim() || DEFAULT_TIMESTAMP_URL).replace(
    /\/+$/,
    '',
  )
  if (!timestampUrl.startsWith('https://')) {
    throw new Error('CAIRN_TIMESTAMP_URL must use https')
  }

  if (rawMode === 'pfx') {
    const certificate =
      env['WINDOWS_CERTIFICATE']?.trim() ||
      env['WIN_CSC_LINK']?.trim() ||
      env['CSC_LINK']?.trim() ||
      ''
    if (certificate === '') {
      throw new Error('WINDOWS_CERTIFICATE (base64 PFX) is required for pfx signing')
    }
    const password =
      env['WINDOWS_CERTIFICATE_PASSWORD'] ??
      env['WIN_CSC_KEY_PASSWORD'] ??
      env['CSC_KEY_PASSWORD'] ??
      ''
    if (password === '') {
      throw new Error('WINDOWS_CERTIFICATE_PASSWORD is required for pfx signing')
    }
    return { mode: 'pfx', publisher, timestampUrl, certificate, password }
  }

  return {
    mode: 'azure',
    publisher,
    timestampUrl,
    endpoint: required(env, 'AZURE_SIGN_ENDPOINT'),
    account: required(env, 'AZURE_SIGN_ACCOUNT'),
    profile: required(env, 'AZURE_SIGN_PROFILE'),
  }
}

/**
 * 传给 electron-builder 子进程的环境。PFX 只走环境变量，避免出现在命令行与日志。
 * @param {SigningConfig} config
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function signingEnvironment(config, base = process.env) {
  const env = { ...base }
  // 未显式配置签名时沿用调用方设置（默认关闭自动发现）；启用签名时必须关闭，避免误用本机证书。
  if (config.mode !== 'none' || env['CSC_IDENTITY_AUTO_DISCOVERY'] === undefined) {
    env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false'
  }
  if (config.mode === 'pfx') {
    env['WIN_CSC_LINK'] = config.certificate
    env['WIN_CSC_KEY_PASSWORD'] = config.password
  }
  return env
}

/**
 * 传给 electron-builder 的配置覆盖。数组字段用单值传入，electron-builder 会归一化。
 * @param {SigningConfig} config
 * @returns {string[]}
 */
export function signingBuilderArgs(config) {
  if (config.mode === 'none') return []
  const common = ['--config.win.signExecutable=true']
  if (config.mode === 'pfx') {
    return [
      ...common,
      `--config.win.signtoolOptions.publisherName=${config.publisher}`,
      '--config.win.signtoolOptions.signingHashAlgorithms=sha256',
      `--config.win.signtoolOptions.rfc3161TimeStampServer=${config.timestampUrl}`,
    ]
  }
  return [
    ...common,
    `--config.win.azureSignOptions.publisherName=${config.publisher}`,
    `--config.win.azureSignOptions.endpoint=${config.endpoint}`,
    `--config.win.azureSignOptions.codeSigningAccountName=${config.account}`,
    `--config.win.azureSignOptions.certificateProfileName=${config.profile}`,
    `--config.win.azureSignOptions.timestampRfc3161=${config.timestampUrl}`,
    '--config.win.azureSignOptions.fileDigest=SHA256',
  ]
}

/**
 * 发布说明与 provenance 使用的签名摘要；不包含证书、密码或云端凭据。
 * @param {SigningConfig} config
 * @returns {{ mode: 'none' | 'pfx' | 'azure'; publisher?: string; timestampUrl?: string }}
 */
export function signatureSummary(config) {
  if (config.mode === 'none') return { mode: 'none' }
  return {
    mode: config.mode,
    publisher: config.publisher,
    timestampUrl: config.timestampUrl,
  }
}

/**
 * 隐藏输出里可能出现的凭据。签名失败时 signtool 不会输出密码，但这里仍做防御。
 * @param {string} text
 * @param {SigningConfig} config
 * @returns {string}
 */
export function redactSecrets(text, config) {
  let output = text
  if (config.mode === 'pfx') {
    for (const value of [config.certificate, config.password]) {
      if (value.length >= 4) output = output.split(value).join('***')
    }
  }
  return output
}

/**
 * 定位 signtool.exe：显式 `SIGNTOOL_PATH` 优先，其次 Windows SDK 中版本最高的 x64 工具。
 * @param {{
 *   env?: Readonly<Record<string, string | undefined>>;
 *   platform?: NodeJS.Platform;
 *   exists?: (file: string) => boolean;
 *   list?: (dir: string) => string[];
 * }} [options]
 * @returns {string}
 */
export function findSignTool({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  list = (dir) => readdirSync(dir),
} = {}) {
  if (platform !== 'win32') throw new Error('code signing is supported on Windows only')
  const explicit = env['SIGNTOOL_PATH']?.trim()
  if (explicit && exists(explicit)) return explicit
  /** @type {string[]} */
  const roots = []
  for (const root of [env['ProgramFiles(x86)'], env['ProgramFiles']]) {
    if (root !== undefined && root !== '') roots.push(root)
  }
  for (const root of roots) {
    const bin = path.join(root, 'Windows Kits/10/bin')
    let versions
    try {
      versions = list(bin)
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => {
          const left = a.split('.').map(Number)
          const right = b.split('.').map(Number)
          for (let index = 0; index < 4; index += 1) {
            const leftPart = left[index] ?? 0
            const rightPart = right[index] ?? 0
            if (leftPart !== rightPart) return rightPart - leftPart
          }
          return 0
        })
    } catch {
      continue
    }
    for (const version of versions) {
      const candidate = path.join(bin, version, 'x64/signtool.exe')
      if (exists(candidate)) return candidate
    }
  }
  return 'signtool'
}

const AUTHENTICODE_SCRIPT = [
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:CAIRN_SIGN_FILE',
  '$stamper = $signature.TimeStamperCertificate',
  '[pscustomobject]@{',
  '  status = $signature.Status.ToString()',
  '  subject = $signature.SignerCertificate.Subject',
  '  thumbprint = $signature.SignerCertificate.Thumbprint',
  '  timestamped = $null -ne $stamper',
  '} | ConvertTo-Json -Compress',
].join('\n')

/**
 * 读取 Authenticode 状态；解析失败返回 undefined。
 * @param {string} output
 * @returns {{ status: string; subject: string; thumbprint: string; timestamped: boolean } | undefined}
 */
export function parseAuthenticode(output) {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .at(-1)
  if (line === undefined) return undefined
  try {
    const parsed = JSON.parse(line)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.subject !== 'string' ||
      typeof parsed.timestamped !== 'boolean'
    ) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 校验一个可执行文件；返回问题列表，空数组表示通过。
 * @param {{
 *   file: string;
 *   config: SigningConfig;
 *   signTool: string;
 *   runner?: typeof spawnSync;
 *   platform?: NodeJS.Platform;
 *   exists?: (file: string) => boolean;
 * }} options
 * @returns {string[]}
 */
export function verifyAuthenticode({
  file,
  config,
  signTool,
  runner = spawnSync,
  platform = process.platform,
  exists = existsSync,
}) {
  if (config.mode === 'none') return ['code signing is disabled']
  if (!exists(file)) return [`missing signed artifact: ${file}`]
  if (platform !== 'win32') return ['code signing verification is supported on Windows only']

  const problems = []
  const verify = runner(signTool, ['verify', '/pa', '/all', '/v', file], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  const output = redactSecrets(`${verify.stdout ?? ''}${verify.stderr ?? ''}`, config)
  if (verify.status !== 0 || !/Successfully verified/i.test(output)) {
    problems.push(
      `signtool verify failed for ${path.basename(file)}: ${output.trim().slice(0, 500)}`,
    )
  }

  const query = runner(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', AUTHENTICODE_SCRIPT],
    {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, CAIRN_SIGN_FILE: file },
    },
  )
  const parsed = query.status === 0 ? parseAuthenticode(`${query.stdout ?? ''}`) : undefined
  if (parsed === undefined) {
    problems.push(
      `cannot read Authenticode status for ${path.basename(file)}: ${redactSecrets(
        `${query.stdout ?? ''}${query.stderr ?? ''}`,
        config,
      )
        .trim()
        .slice(0, 300)}`,
    )
    return problems
  }
  if (parsed.status !== 'Valid') {
    problems.push(`${path.basename(file)} signature status is ${parsed.status}`)
  }
  if (parsed.subject !== config.publisher) {
    problems.push(
      `${path.basename(file)} publisher is "${parsed.subject}", expected "${config.publisher}"`,
    )
  }
  if (!parsed.timestamped) {
    problems.push(`${path.basename(file)} signature has no RFC 3161 timestamp`)
  }
  return problems
}

/**
 * 发布构建必须签名的文件：安装包与解包主程序；安装目录存在时再加主程序与卸载程序。
 * @param {{ distDir: string; version: string; installedDir?: string | undefined }} input
 * @returns {{ label: string; required: string }[]}
 */
export function signatureTargets({ distDir, version, installedDir }) {
  const targets = [
    {
      label: 'NSIS installer',
      required: path.join(distDir, `${PRODUCT_NAME}-${version}-x64-setup.exe`),
    },
    { label: 'application', required: path.join(distDir, 'win-unpacked', `${PRODUCT_NAME}.exe`) },
  ]
  if (installedDir !== undefined) {
    targets.push(
      { label: 'installed application', required: path.join(installedDir, `${PRODUCT_NAME}.exe`) },
      {
        label: 'uninstaller',
        required: path.join(installedDir, `Uninstall ${PRODUCT_NAME}.exe`),
      },
    )
  }
  return targets
}

/**
 * 校验整套发布产物。
 * @param {{
 *   distDir: string;
 *   version: string;
 *   installedDir?: string | undefined;
 *   config: SigningConfig;
 *   signTool?: string | undefined;
 *   runner?: typeof spawnSync;
 *   platform?: NodeJS.Platform;
 *   exists?: (file: string) => boolean;
 * }} options
 * @returns {string[]}
 */
export function verifyReleaseSignatures({
  distDir,
  version,
  installedDir,
  config,
  signTool,
  runner = spawnSync,
  platform = process.platform,
  exists = existsSync,
}) {
  if (config.mode === 'none') return ['refusing to verify an unsigned release']
  const tool = signTool ?? findSignTool({ platform, exists })
  const problems = []
  for (const target of signatureTargets({ distDir, version, installedDir })) {
    problems.push(
      ...verifyAuthenticode({
        file: target.required,
        config,
        signTool: tool,
        runner,
        platform,
        exists,
      }),
    )
  }
  return problems
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   env?: Readonly<Record<string, string | undefined>>;
 *   platform?: NodeJS.Platform;
 *   runner?: typeof spawnSync;
 *   exists?: (file: string) => boolean;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  runner = spawnSync,
  exists = existsSync,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  /** @param {string} flag */
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const distDir = value('--dist')
  const version = value('--version')
  const installedDir = value('--installed')
  if (distDir === undefined || version === undefined) {
    error('usage: windows-signing.mjs --dist <dir> --version <version> [--installed <dir>]')
    return 1
  }
  const config = readSigningConfig(env)
  const problems = verifyReleaseSignatures({
    distDir,
    version,
    installedDir,
    config,
    runner,
    platform,
    exists,
  })
  if (problems.length > 0) {
    for (const problem of problems) error(`sign: ${problem}`)
    return 1
  }
  log(`sign: ${signatureTargets({ distDir, version, installedDir }).length} artifacts verified`)
  return 0
}

/* v8 ignore start -- CLI bootstrap is executed by the release workflow, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (failure) {
    console.error(`sign: ${failure instanceof Error ? failure.message : String(failure)}`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
