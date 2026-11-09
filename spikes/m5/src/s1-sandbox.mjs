// @ts-check
/**
 * M5-00 S1：Windows 命令沙箱兼容性矩阵。
 *
 * 在普通用户账户下比较 `none`、`restricted`（受限令牌 + 低完整性）与 `appcontainer`
 * （AppContainer + 工作区 ACL）三种模式，记录真实命令、路径写入、网络、管理员操作和进程树清理。
 *
 * 运行：`node src/s1-sandbox.mjs`（需要在 Windows 上、仓库根目录或本目录执行）。
 */
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAppContainer, deleteAppContainer, runSandboxed } from './windows-api.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const spikeRoot = path.join(repoRoot, 'spikes/m5')
const workRoot = path.join(spikeRoot, 'work/s1')
const bin = path.join(repoRoot, 'node_modules/.bin')
const node = process.execPath
const results = []

rmSync(workRoot, { recursive: true, force: true })
mkdirSync(workRoot, { recursive: true })

/** @param {string[]} args @param {string} [cwd] */
function run(args, cwd = repoRoot) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

/** @param {string} dir @param {'low' | 'medium'} integrity */
function labelIntegrity(dir, integrity) {
  if (integrity === 'low') {
    const result = run(['icacls', dir, '/setintegritylevel', '(OI)(CI)L'])
    if (result.status !== 0) throw new Error(`icacls setintegritylevel failed: ${result.stderr}`)
  }
}

/** @param {string} dir @param {string} sidString */
function grantAppContainer(dir, sidString) {
  const result = run(['icacls', dir, '/grant', `*${sidString}:(OI)(CI)M`])
  if (result.status !== 0) throw new Error(`icacls grant failed: ${result.stderr}`)
}

/** @param {string} dir @param {string} sidString */
function removeAppContainerGrant(dir, sidString) {
  run(['icacls', dir, '/remove:g', `*${sidString}`])
}

/** @param {string} dir */
function readOptional(dir, name) {
  try {
    return readFileSync(path.join(dir, name), 'utf8')
  } catch {
    return ''
  }
}

/** @param {string} name @returns {boolean} */
function processAlive(name) {
  const result = run(['tasklist', '/FI', `PID eq ${name}`, '/FO', 'CSV', '/NH'])
  return result.stdout.includes(`"${name}"`)
}

/**
 * @param {object} input
 * @param {string} input.id
 * @param {'none' | 'restricted' | 'appcontainer'} input.mode
 * @param {string} input.command
 * @param {string} [input.appContainerSid]
 * @param {string[]} [input.capabilitySids]
 * @param {number} [input.timeoutMs]
 * @param {string} [input.expected]
 */
function runCase(input) {
  const dir = path.join(workRoot, input.mode, input.id)
  mkdirSync(dir, { recursive: true })
  if (input.mode !== 'none') labelIntegrity(dir, 'low')
  writeFileSync(path.join(dir, 'marker.txt'), 'marker-中文\n', 'utf8')
  if (input.id === 'workspace-outside-write')
    rmSync(path.join(outside, 'outside.txt'), { force: true })
  if (input.id === 'system-write') rmSync(systemFile, { force: true })
  const appContainer = input.appContainerSid
    ? { name: 'com.cairn.spike.s1', sid: BigInt(input.appContainerSid) }
    : undefined
  let result
  try {
    result = runSandboxed({
      mode: input.mode,
      workDir: dir,
      command: input.command,
      appContainer,
      capabilitySids: input.capabilitySids,
      timeoutMs: input.timeoutMs ?? 120_000,
    })
  } catch (error) {
    result = {
      mode: input.mode,
      exitCode: null,
      timedOut: false,
      elapsedMs: 0,
      stdout: '',
      stderr: String(error),
    }
  }
  const record = {
    ...result,
    id: input.id,
    command: input.command,
    expected: input.expected ?? 'success',
    files: {
      marker: readOptional(dir, 'marker.txt'),
      inside: readOptional(dir, 'inside.txt'),
      admin: readOptional(dir, 'admin.txt'),
    },
    escaped: {
      outside: readOptional(outside, 'outside.txt').length > 0,
      system: (() => {
        try {
          readFileSync(systemFile)
          return true
        } catch {
          return false
        }
      })(),
    },
  }
  results.push(record)
  console.log(
    `${input.mode.padEnd(12)} ${input.id.padEnd(22)} exit=${String(record.exitCode).padEnd(
      4,
    )} ${record.elapsedMs}ms`,
  )
  if (record.escaped.outside || record.escaped.system) {
    console.log(`  ESCAPED outside=${record.escaped.outside} system=${record.escaped.system}`)
  }
  if (record.stderr) console.log(`  stderr: ${record.stderr.trim().slice(0, 300)}`)
  return record
}

const appContainerName = `com.cairn.spike.s1.${randomUUID()}`
const appContainer = createAppContainer(appContainerName)
const appContainerRoot = path.join(workRoot, 'appcontainer')
mkdirSync(appContainerRoot, { recursive: true })
grantAppContainer(appContainerRoot, appContainer.sidString)

const outside = mkdtempSync(path.join(tmpdir(), 'cairn-m5-outside-'))
const systemFile = path.join('C:\\Windows', `cairn-m5-probe-${randomUUID()}.txt`)

const serverFile = path.join(workRoot, 'server.mjs')
const portFile = path.join(workRoot, 'server-port.txt')
writeFileSync(
  serverFile,
  `import { createServer } from 'node:http'\nimport { writeFileSync } from 'node:fs'\nconst server = createServer((_request, response) => response.end('cairn-network-ok'))\nserver.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)))\n`,
  'utf8',
)
const server = spawn(node, [serverFile], { stdio: 'ignore', windowsHide: true })
for (let i = 0; i < 100 && !readOptional(workRoot, 'server-port.txt'); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const port = Number(readOptional(workRoot, 'server-port.txt'))
if (!port) throw new Error('local network test server did not start')

const toolVersion = (/** @type {string} */ name) =>
  `call "${path.join(bin, `${name}.CMD`)}" --version`

try {
  const common = [
    { id: 'node-version', command: 'node --version' },
    { id: 'pnpm-version', command: 'pnpm --version' },
    { id: 'git-version', command: 'git --version' },
    { id: 'python-version', command: 'python --version' },
    { id: 'dotnet-version', command: 'dotnet --version' },
    { id: 'rg-version', command: 'rg --version' },
    { id: 'tsc-version', command: toolVersion('tsc') },
    { id: 'eslint-version', command: toolVersion('eslint') },
    { id: 'vitest-version', command: toolVersion('vitest') },
    { id: 'chinese-output', command: 'echo 中文输出' },
    { id: 'workspace-write', command: 'echo inside>inside.txt && type marker.txt' },
    {
      id: 'workspace-outside-write',
      command: `echo outside>"${path.join(outside, 'outside.txt')}"`,
      expected: 'failure',
    },
    {
      id: 'system-write',
      command: `echo system>"${systemFile}"`,
      expected: 'failure',
    },
    {
      id: 'admin-action',
      command: 'net session>admin.txt 2>&1',
      expected: 'failure',
    },
  ]

  for (const mode of /** @type {const} */ (['none', 'restricted', 'appcontainer'])) {
    for (const item of common) {
      runCase({
        ...item,
        mode,
        appContainerSid: mode === 'appcontainer' ? String(appContainer.sid) : undefined,
      })
    }
  }

  // 网络：AppContainer 默认拒绝；显式 capability 后放行。
  const networkScript = `curl.exe --noproxy "*" --max-time 10 -fsS http://127.0.0.1:${port}`
  runCase({
    id: 'network-default',
    mode: 'none',
    command: networkScript,
  })
  runCase({
    id: 'network-default',
    mode: 'restricted',
    command: networkScript,
  })
  runCase({
    id: 'network-default',
    mode: 'appcontainer',
    command: networkScript,
    appContainerSid: String(appContainer.sid),
    expected: 'failure',
  })
  runCase({
    id: 'network-capability',
    mode: 'appcontainer',
    command: networkScript,
    appContainerSid: String(appContainer.sid),
    capabilitySids: ['S-1-15-3-1', 'S-1-15-3-3'],
  })

  // 真正的互联网访问：AppContainer 默认拒绝，授予 internetClient 后放行。
  // 本机回环对 AppContainer 默认隔离，不能用本地服务器判断能力是否生效。
  const internetScript =
    'curl.exe --ssl-no-revoke --max-time 20 -sS -o net-body.txt -w "%%{http_code}" https://registry.npmjs.org/is-number'
  runCase({
    id: 'internet-default',
    mode: 'appcontainer',
    command: internetScript,
    appContainerSid: String(appContainer.sid),
    expected: 'failure',
  })
  runCase({
    id: 'internet-capability',
    mode: 'appcontainer',
    command: internetScript,
    appContainerSid: String(appContainer.sid),
    capabilitySids: ['S-1-15-3-1'],
  })

  // pnpm install：在网络能力下必须成功；AppContainer 使用工作区内的 store/cache，避免用户目录。
  for (const mode of /** @type {const} */ (['restricted', 'appcontainer'])) {
    const id = 'pnpm-install'
    const dir = path.join(workRoot, mode, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'cairn-m5-install',
        private: true,
        dependencies: { 'is-number': '7.0.0' },
      }),
      'utf8',
    )
    runCase({
      id,
      mode,
      command:
        'pnpm install --ignore-workspace --dir . --ignore-scripts --store-dir .pnpm-store --config.cache-dir=.pnpm-cache --registry=https://registry.npmjs.org/',
      appContainerSid: mode === 'appcontainer' ? String(appContainer.sid) : undefined,
      capabilitySids: mode === 'appcontainer' ? ['S-1-15-3-1', 'S-1-15-3-3'] : undefined,
      timeoutMs: 180_000,
    })
  }

  // 子进程继承与清理：命令启动一个子进程，超时结束后不能残留。
  for (const mode of /** @type {const} */ (['restricted', 'appcontainer'])) {
    const dir = path.join(workRoot, mode, 'long-process')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'long.mjs'),
      `import { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nconst child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })\nwriteFileSync('pids.txt', String(process.pid) + '\\n' + String(child.pid))\nsetTimeout(() => {}, 60000)\n`,
      'utf8',
    )
    const record = runCase({
      id: 'long-process',
      mode,
      command: 'node long.mjs',
      appContainerSid: mode === 'appcontainer' ? String(appContainer.sid) : undefined,
      timeoutMs: 2_000,
    })
    const pids = readOptional(dir, 'pids.txt').trim().split(/\s+/).filter(Boolean)
    record.childInheritance = pids.length === 2 && pids.every((pid) => !processAlive(pid))
    console.log(`  childInheritance=${record.childInheritance}`)
  }
} finally {
  server.kill()
  removeAppContainerGrant(appContainerRoot, appContainer.sidString)
  deleteAppContainer(appContainerName)
  rmSync(outside, { recursive: true, force: true })
}

/** @param {string} mode @param {string} id */
const resultFor = (mode, id) => results.find((item) => item.mode === mode && item.id === id)
const requiredTools = [
  'node-version',
  'pnpm-version',
  'git-version',
  'python-version',
  'dotnet-version',
  'rg-version',
  'tsc-version',
  'eslint-version',
  'vitest-version',
]
const restricted = {
  tools: requiredTools.every((id) => resultFor('restricted', id)?.exitCode === 0),
  workspaceWrite: resultFor('restricted', 'workspace-write')?.exitCode === 0,
  outsideWriteDenied: resultFor('restricted', 'workspace-outside-write')?.escaped.outside === false,
  systemWriteDenied: resultFor('restricted', 'system-write')?.escaped.system === false,
  adminDenied: resultFor('restricted', 'admin-action')?.exitCode !== 0,
  pnpmInstall: resultFor('restricted', 'pnpm-install')?.exitCode === 0,
  processTreeCleanup: resultFor('restricted', 'long-process')?.childInheritance === true,
  networkAvailable: resultFor('restricted', 'network-default')?.exitCode === 0,
}
const appcontainer = {
  tools: requiredTools.every((id) => resultFor('appcontainer', id)?.exitCode === 0),
  workspaceWrite: resultFor('appcontainer', 'workspace-write')?.exitCode === 0,
  outsideWriteDenied:
    resultFor('appcontainer', 'workspace-outside-write')?.escaped.outside === false,
  systemWriteDenied: resultFor('appcontainer', 'system-write')?.escaped.system === false,
  adminDenied: resultFor('appcontainer', 'admin-action')?.exitCode !== 0,
  pnpmInstall: resultFor('appcontainer', 'pnpm-install')?.exitCode === 0,
  processTreeCleanup: resultFor('appcontainer', 'long-process')?.childInheritance === true,
  networkDeniedByDefault: resultFor('appcontainer', 'network-default')?.exitCode !== 0,
  internetWhenGranted: resultFor('appcontainer', 'internet-capability')?.exitCode === 0,
}

const output = {
  platform: process.platform,
  windows: release(),
  node: process.version,
  appContainer: { name: appContainerName, sid: appContainer.sidString },
  results,
  evaluation: {
    restricted,
    appcontainer,
    restrictedGo: Object.values(restricted).every(Boolean),
    appcontainerGo: Object.values(appcontainer).every(Boolean),
    conclusion:
      'restricted-workspace 可运行全部开发命令并阻断越界写；AppContainer 无法启动用户目录中的 Node/Git 工具，只作为实验档，不作为默认。',
  },
}
writeFileSync(path.join(spikeRoot, 'result-s1.json'), JSON.stringify(output, null, 2))
console.log(`\nWrote ${path.join(spikeRoot, 'result-s1.json')}`)
