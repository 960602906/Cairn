// @ts-check
/**
 * M5-00 S3：本地 HTTPS 静态更新源 + electron-updater 预研。
 *
 * 生成两版产物元数据与 blockmap，启动自签名 HTTPS 静态源，在 Electron 主进程里用
 * electron-updater 检查与下载；同时验证 404、错误 SHA512、断网与下载损坏的失败路径。
 *
 * 只验证“静态源 + 下载校验”，不执行 quitAndInstall，也不验证代码签名（M5-06/M5-08）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'work/s3')
const electron = createRequire(path.join(root, '../../apps/desktop/package.json'))('electron')
rmSync(work, { recursive: true, force: true })
mkdirSync(path.join(work, 'www'), { recursive: true })

const cert = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(work, 'key.pem'),
    '-out',
    path.join(work, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { encoding: 'utf8' },
)
if (cert.status !== 0) throw new Error(`openssl failed: ${cert.stderr}`)

/** @param {Buffer} data */
const sha512 = (data) => createHash('sha512').update(data).digest('base64')

/**
 * @param {string} name
 * @param {string} version
 * @param {boolean} corruptSha
 */
function makeRelease(name, version, corruptSha = false) {
  const dir = path.join(work, 'www', name)
  mkdirSync(dir, { recursive: true })
  const artifact = Buffer.concat([
    Buffer.from('Cairn fake NSIS artifact\n'),
    randomBytes(1024 * 1024),
  ])
  const artifactName = `Cairn Setup ${version}.exe`
  writeFileSync(path.join(dir, artifactName), artifact)
  const blockmap = Buffer.from(
    JSON.stringify({
      version,
      files: [{ name: artifactName, offset: 0, checksums: [sha512(artifact)] }],
    }),
  )
  writeFileSync(path.join(dir, `${artifactName}.blockmap`), blockmap)
  const digest = corruptSha ? sha512(Buffer.from('wrong')) : sha512(artifact)
  writeFileSync(
    path.join(dir, 'latest.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${encodeURIComponent(artifactName)}`,
      `    sha512: ${digest}`,
      `    size: ${artifact.length}`,
      `path: ${artifactName}`,
      `sha512: ${digest}`,
      "releaseDate: '2026-11-10T00:00:00.000Z'",
      '',
    ].join('\n'),
  )
  return { dir, artifactName, artifact, blockmap, digest }
}

const valid = makeRelease('valid', '0.1.1')
const badSha = makeRelease('bad-sha', '0.1.1', true)
const corrupt = makeRelease('corrupt', '0.1.1')
// 元数据写完后破坏文件，模拟下载中断/损坏。
writeFileSync(
  path.join(corrupt.dir, corrupt.artifactName),
  Buffer.concat([corrupt.artifact.subarray(0, 128)]),
)

const server = createServer(
  {
    key: readFileSync(path.join(work, 'key.pem')),
    cert: readFileSync(path.join(work, 'cert.pem')),
  },
  (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'https://localhost').pathname)
    const file = path.join(work, 'www', pathname)
    if (!file.startsWith(path.join(work, 'www')) || !existsSync(file)) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-length': statSync(file).size })
    createReadStream(file).pipe(response)
  },
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port

const updaterScript = path.join(work, 'updater.cjs')
const updaterProfile = path.join(work, 'profile')
mkdirSync(updaterProfile, { recursive: true })
const updaterConfig = path.join(work, 'dev-app-update.yml')
writeFileSync(
  updaterConfig,
  [
    'provider: generic',
    `url: https://127.0.0.1:${port}/valid/`,
    'updaterCacheDirName: cairn-m5-spike-updater',
    '',
  ].join('\n'),
)
const updaterConfigUnsigned = path.join(work, 'dev-app-update-unsigned.yml')
writeFileSync(
  updaterConfigUnsigned,
  [
    'provider: generic',
    `url: https://127.0.0.1:${port}/valid/`,
    'updaterCacheDirName: cairn-m5-spike-updater-unsigned',
    'publisherName: CN=Cairn Spike',
    '',
  ].join('\n'),
)
writeFileSync(
  updaterScript,
  `const { app } = require('electron')
const { autoUpdater } = require('electron-updater')
const { createRequire } = require('node:module')
const { writeFileSync } = require('node:fs')
const updaterRequire = createRequire(require.resolve('electron-updater'))
const { parse } = updaterRequire('semver')
app.setPath('userData', process.env.CAIRN_SPIKE_USER_DATA)
app.setPath('cache', process.env.CAIRN_SPIKE_CACHE)
app.commandLine.appendSwitch('ignore-certificate-errors')
if (process.env.CAIRN_SPIKE_PROXY) {
  app.commandLine.appendSwitch('proxy-server', process.env.CAIRN_SPIKE_PROXY)
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>')
}
app.whenReady().then(async () => {
  const base = process.env.CAIRN_SPIKE_FEED
  autoUpdater.forceDevUpdateConfig = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.currentVersion = parse('0.1.0')
  autoUpdater.updateConfigPath = process.env.CAIRN_SPIKE_CONFIG
  autoUpdater.logger = { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m), debug: () => {} }
  autoUpdater.setFeedURL({ provider: 'generic', url: base })
  try {
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo
    writeFileSync(process.env.CAIRN_SPIKE_OUT, JSON.stringify({ ok: true, version: info?.version, available: result?.isUpdateAvailable }))
    if (process.env.CAIRN_SPIKE_DOWNLOAD === '1') {
      const files = await autoUpdater.downloadUpdate()
      writeFileSync(process.env.CAIRN_SPIKE_OUT, JSON.stringify({ ok: true, version: info?.version, available: result?.isUpdateAvailable, downloaded: true, files }))
    }
  } catch (error) {
    writeFileSync(process.env.CAIRN_SPIKE_OUT, JSON.stringify({ ok: false, error: String(error) }))
  }
  app.quit()
})`,
)

/**
 * @param {string} name
 * @param {string} feed
 * @param {boolean} download
 * @param {boolean} expectedSuccess
 * @param {string} [config]
 * @param {NodeJS.ProcessEnv} [extraEnv]
 * @returns {Promise<{ name: string, ok: boolean, expectedSuccess: boolean, pass: boolean, detail: string }>}
 */
async function runUpdater(
  name,
  feed,
  download,
  expectedSuccess,
  config = updaterConfig,
  extraEnv = {},
) {
  const out = path.join(work, `${name}.json`)
  const child = spawn(electron, [updaterScript], {
    cwd: work,
    env: {
      ...process.env,
      CAIRN_SPIKE_FEED: feed,
      CAIRN_SPIKE_OUT: out,
      CAIRN_SPIKE_CONFIG: config,
      CAIRN_SPIKE_USER_DATA: path.join(updaterProfile, 'user-data'),
      CAIRN_SPIKE_CACHE: path.join(updaterProfile, 'cache'),
      LOCALAPPDATA: path.join(updaterProfile, 'local-app-data'),
      CAIRN_SPIKE_DOWNLOAD: download ? '1' : '0',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))
  await new Promise((resolve) => child.on('exit', resolve))
  if (!existsSync(out)) {
    return {
      name,
      ok: false,
      expectedSuccess,
      pass: expectedSuccess === false,
      detail: output.slice(-800),
    }
  }
  const result = JSON.parse(readFileSync(out, 'utf8'))
  return {
    name,
    ok: result.ok === true,
    expectedSuccess,
    pass: result.ok === expectedSuccess,
    detail: JSON.stringify(result),
  }
}

const results = []
results.push(await runUpdater('valid', `https://127.0.0.1:${port}/valid/`, false, true))
results.push(await runUpdater('download', `https://127.0.0.1:${port}/valid/`, true, true))
results.push(await runUpdater('404', `https://127.0.0.1:${port}/missing/`, false, false))
results.push(await runUpdater('bad-sha', `https://127.0.0.1:${port}/bad-sha/`, true, false))
results.push(await runUpdater('corrupt', `https://127.0.0.1:${port}/corrupt/`, true, false))
results.push(
  await runUpdater(
    'unsigned',
    `https://127.0.0.1:${port}/valid/`,
    true,
    false,
    updaterConfigUnsigned,
  ),
)
results.push(
  await runUpdater(
    'proxy-failure',
    `https://127.0.0.1:${port}/valid/`,
    false,
    false,
    updaterConfig,
    {
      CAIRN_SPIKE_PROXY: 'http://127.0.0.1:1',
    },
  ),
)

server.close()
results.push(await runUpdater('offline', `https://127.0.0.1:${port}/valid/`, false, false))

const output = {
  port,
  releases: { valid: valid.digest, badSha: badSha.digest, corrupt: corrupt.digest },
  results,
  allPassed: results.every((result) => result.pass),
  note: '自签名证书仅用于预研；正式更新源必须是公开可信 HTTPS。',
}
writeFileSync(path.join(root, 'result-s3.json'), JSON.stringify(output, null, 2))
for (const result of results) {
  console.log(`${result.pass ? 'pass' : 'fail'} ${result.name} (ok=${result.ok}): ${result.detail}`)
}
if (!output.allPassed) process.exitCode = 1
