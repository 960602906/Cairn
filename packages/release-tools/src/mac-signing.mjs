// @ts-check
/**
 * macOS 代码签名与公证配置（M6-02，ADR-0041；ad-hoc 默认见 ADR-0049）。
 *
 * 签名交给 electron-builder：Developer ID 证书与密码只经 `CSC_LINK` / `CSC_KEY_PASSWORD`
 * 传给子进程，不写命令行；`CAIRN_MAC_IDENTITY` 决定用哪张证书，避免构建机上有多个身份时
 * 自动挑错。公证由 electron-builder 调用 `@electron/notarize`，凭据只走
 * `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。
 *
 * 没有 Developer ID 证书时使用 `adhoc`：electron-builder 用 `identity: "-"` 做 ad-hoc 签名。
 * 这一步不能省略——`identity: null` 会让 .app 保留 Electron 自带、未覆盖打包资源的
 * linker 签名，`codesign --verify` 报 “code has no resources but signature indicates they
 * must be present”，下载后的应用会被 Gatekeeper 当成“已损坏”。ad-hoc 签名不改变发布者
 * 身份，也不公证，首次启动仍需用户显式放行。
 *
 * 构建后可用 `verifyMacSignature` 校验：`codesign --verify --deep --strict`；
 * Developer ID 产物再跑 `spctl --assess` 与 `xcrun stapler validate`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const MAC_SIGNING_MODES = ['adhoc', 'developer-id']

/**
 * @typedef {{ mode: 'adhoc' }} MacSigningAdhoc
 * @typedef {{
 *   mode: 'developer-id';
 *   identity: string;
 *   certificate: string;
 *   password: string;
 *   notarize: { appleId: string; appleIdPassword: string; teamId: string };
 * }} MacSigningDeveloperId
 * @typedef {MacSigningAdhoc | MacSigningDeveloperId} MacSigningConfig
 */

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} name
 * @returns {string}
 */
function required(env, name) {
  const value = env[name]?.trim() ?? ''
  if (value === '') throw new Error(`${name} is required when macOS signing is enabled`)
  return value
}

/**
 * 从 CI secrets / 环境读取 macOS 签名配置。未配置时返回 `{ mode: 'adhoc' }`：
 * ad-hoc 签名是所有 macOS 产物的最低要求，否则下载后的 .app 会被 Gatekeeper 判为损坏。
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {MacSigningConfig}
 */
export function readMacSigningConfig(env = process.env) {
  const rawMode = (env['CAIRN_MAC_SIGN_MODE']?.trim() || 'adhoc').toLowerCase()
  if (!MAC_SIGNING_MODES.includes(rawMode)) {
    throw new Error(`CAIRN_MAC_SIGN_MODE must be one of ${MAC_SIGNING_MODES.join(', ')}`)
  }
  if (rawMode === 'adhoc') return { mode: 'adhoc' }

  const identity = required(env, 'CAIRN_MAC_IDENTITY')
  if (!identity.startsWith('Developer ID Application:')) {
    throw new Error('CAIRN_MAC_IDENTITY must be a Developer ID Application identity')
  }
  const certificate = env['MAC_CERTIFICATE']?.trim() || env['CSC_LINK']?.trim() || ''
  if (certificate === '') {
    throw new Error('MAC_CERTIFICATE (base64 p12) is required for Developer ID signing')
  }
  const password = env['MAC_CERTIFICATE_PASSWORD']?.trim() || env['CSC_KEY_PASSWORD']?.trim() || ''
  if (password === '') {
    throw new Error('MAC_CERTIFICATE_PASSWORD is required for Developer ID signing')
  }
  // 可分发产物必须公证：缺凭据时直接失败，而不是产出一个 Gatekeeper 会拒绝的 DMG。
  return {
    mode: 'developer-id',
    identity,
    certificate,
    password,
    notarize: {
      appleId: required(env, 'APPLE_ID'),
      appleIdPassword: required(env, 'APPLE_APP_SPECIFIC_PASSWORD'),
      teamId: required(env, 'APPLE_TEAM_ID'),
    },
  }
}

/**
 * 传给 electron-builder 子进程的环境。证书只走环境变量，避免出现在命令行与日志。
 * @param {MacSigningConfig} config
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function macSigningEnvironment(config, base = process.env) {
  const env = { ...base }
  // 不自动挑选构建机上的其他身份：签名用哪张证书只由 CAIRN_MAC_IDENTITY 决定。
  env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false'
  if (config.mode === 'developer-id') {
    env['CSC_LINK'] = config.certificate
    env['CSC_KEY_PASSWORD'] = config.password
    env['APPLE_ID'] = config.notarize.appleId
    env['APPLE_APP_SPECIFIC_PASSWORD'] = config.notarize.appleIdPassword
    env['APPLE_TEAM_ID'] = config.notarize.teamId
  }
  return env
}

/**
 * 传给 electron-builder 的 macOS 配置覆盖。
 *
 * `identity: "-"` 是 electron-builder 的 ad-hoc 签名入口：它会给主程序、helper 与嵌套
 * framework 重新签名并封存 Resources。DMG 自身不参与 Gatekeeper 校验，ad-hoc 模式下
 * 关闭 DMG 签名，避免构建机上有真实证书时被 `findIdentity` 的子串匹配误用。
 * @param {MacSigningConfig} config
 * @returns {string[]}
 */
export function macSigningBuilderArgs(config) {
  if (config.mode === 'adhoc') {
    return ['--config.mac.identity=-', '--config.dmg.sign=false']
  }
  return [`--config.mac.identity=${config.identity}`, '--config.mac.notarize=true']
}

/**
 * 发布说明与 provenance 使用的签名摘要；不包含证书、密码或账号。
 * @param {MacSigningConfig} config
 * @returns {{ mode: 'adhoc' | 'developer-id'; identity?: string; notarized?: boolean }}
 */
export function macSignatureSummary(config) {
  if (config.mode === 'adhoc') return { mode: 'adhoc', notarized: false }
  return { mode: config.mode, identity: config.identity, notarized: true }
}

/**
 * 需要签名与公证的产物：两个架构的 DMG（安装）与 ZIP（更新）。
 * @param {{ distDir: string; version: string }} input
 * @returns {{ label: string; required: string; app?: string }[]}
 */
export function macSignatureTargets({ distDir, version }) {
  /** @type {{ label: string; required: string; app?: string }[]} */
  const targets = []
  /** @type {readonly [string, string][]} */
  const archDirectories = [
    ['arm64', 'mac-arm64'],
    ['x64', 'mac'],
  ]
  for (const [arch, directory] of archDirectories) {
    targets.push({
      label: `${arch} application`,
      required: path.join(distDir, directory, 'Cairn.app'),
      app: path.join(distDir, directory, 'Cairn.app'),
    })
    targets.push({
      label: `${arch} DMG`,
      required: path.join(distDir, `Cairn-${version}-${arch}.dmg`),
    })
    targets.push({
      label: `${arch} ZIP`,
      required: path.join(distDir, `Cairn-${version}-${arch}.zip`),
    })
  }
  return targets
}

/**
 * 校验一个 macOS 产物；返回问题列表，空数组表示通过。
 *
 * ad-hoc 产物只要求 bundle 签名有效（`codesign --verify`）；`spctl` 必然拒绝没有
 * Developer ID 的构建，不能作为 ad-hoc 的失败条件。Developer ID 产物才检查 Gatekeeper
 * 与公证票据。
 * @param {{
 *   target: { label: string; required: string; app?: string };
 *   notarized: boolean;
 *   gatekeeper?: boolean;
 *   runner?: typeof spawnSync;
 *   platform?: NodeJS.Platform;
 *   exists?: (file: string) => boolean;
 * }} options
 * @returns {string[]}
 */
export function verifyMacSignature({
  target,
  notarized,
  gatekeeper = notarized,
  runner = spawnSync,
  platform = process.platform,
  exists = existsSync,
}) {
  if (platform !== 'darwin') return ['macOS signature verification is supported on macOS only']
  if (!exists(target.required)) return [`missing signed artifact: ${target.required}`]
  /** @type {string[]} */
  const problems = []

  if (target.app !== undefined) {
    const codesign = runner(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', target.app],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    )
    if (codesign.status !== 0) {
      problems.push(
        `codesign verify failed for ${target.label}: ${`${codesign.stdout ?? ''}${codesign.stderr ?? ''}`.trim().slice(0, 500)}`,
      )
    }
    if (gatekeeper) {
      const assess = runner('spctl', ['--assess', '--type', 'execute', '--verbose=4', target.app], {
        encoding: 'utf8',
        timeout: 120_000,
      })
      if (assess.status !== 0) {
        problems.push(
          `Gatekeeper assessment failed for ${target.label}: ${`${assess.stdout ?? ''}${assess.stderr ?? ''}`.trim().slice(0, 500)}`,
        )
      }
    }
    return problems
  }

  // DMG 检查公证票据是否已 stapled；ZIP 不支持 stapling，票据附着在包内的应用上，
  // 以 `.app` 的签名与公证结果为准。
  if (!notarized || path.extname(target.required) === '.zip') return problems
  const staple = runner('xcrun', ['stapler', 'validate', target.required], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (staple.status !== 0) {
    problems.push(
      `notarization ticket is missing from ${target.label}: ${`${staple.stdout ?? ''}${staple.stderr ?? ''}`.trim().slice(0, 500)}`,
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
export function macSigningMain({
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
  if (distDir === undefined || version === undefined) {
    error('usage: mac-signing.mjs --dist <dir> --version <version>')
    return 1
  }
  const config = readMacSigningConfig(env)
  const targets = macSignatureTargets({ distDir, version })
  const problems = targets.flatMap((target) =>
    verifyMacSignature({
      target,
      notarized: config.mode === 'developer-id',
      gatekeeper: config.mode === 'developer-id',
      runner,
      platform,
      exists,
    }),
  )
  if (problems.length > 0) {
    for (const problem of problems) error(`sign: ${problem}`)
    return 1
  }
  log(`sign: ${targets.length} macOS artifacts verified (${config.mode})`)
  return 0
}
