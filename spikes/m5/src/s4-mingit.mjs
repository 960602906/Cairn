// @ts-check
/**
 * M5-00 S4：MinGit 下载、校验、裁剪与检查点命令验证。
 *
 * 官方 GitHub 下载在本机只有约 40 KB/s，npmmirror 的 git-for-windows 镜像约 6 MB/s；
 * 两者内容一致，脚本默认走镜像，并在结果中记录官方资产摘要（由 GitHub API 提供）。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'work/s4')
const downloads = path.join(root, 'downloads')
const version = '2.56.0.4'
const tag = 'v2.56.0.windows.4'
const archiveName = `MinGit-${version}-64-bit.zip`
const url = `https://npmmirror.com/mirrors/git-for-windows/${tag}/${archiveName}`
const officialUrl = `https://github.com/git-for-windows/git/releases/download/${tag}/${archiveName}`
const expectedSha256 = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'
const archive = path.join(downloads, archiveName)
const results = []

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(downloads, { recursive: true })

/** @param {string} file */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** @param {string} dir */
function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile())
      total += statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size
  }
  return total
}

if (!existsSync(archive) || sha256(archive) !== expectedSha256) {
  console.log(`Downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`)
  await pipeline(
    Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)),
    createWriteStream(archive),
  )
}

const actualSha256 = sha256(archive)
if (actualSha256 !== expectedSha256) {
  throw new Error(`SHA256 mismatch: expected ${expectedSha256}, got ${actualSha256}`)
}

const full = path.join(work, 'full')
const lean = path.join(work, 'lean')
mkdirSync(full, { recursive: true })
const extracted = spawnSync('tar', ['-xf', archive, '-C', full], { encoding: 'utf8' })
if (extracted.status !== 0) throw new Error(`tar failed: ${extracted.stderr}`)

// 保留 Git 运行必需部分；去掉 GCM、Avalonia、Skia、文档与 MSYS 运行时。
const { cpSync } = await import('node:fs')
cpSync(full, lean, { recursive: true })
for (const dir of [
  'ucrt64/share/doc',
  'ucrt64/share/man',
  'ucrt64/share/locale',
  'ucrt64/share/gitweb',
  'ucrt64/share/perl5',
  'usr',
]) {
  rmSync(path.join(lean, dir), { recursive: true, force: true })
}

const bin = path.join(lean, 'ucrt64/bin')
const removePatterns = [
  /^Avalonia/i,
  /^Microsoft\.Identity/i,
  /^msalruntime/i,
  /^SkiaSharp/i,
  /^libSkiaSharp/i,
  /^HarfBuzz/i,
  /^libHarfBuzz/i,
  /^av_libglesv2/i,
  /^gcmcore/i,
  /^git-credential-manager/i,
  /^GitHub/i,
  /^GitLab/i,
  /^Atlassian/i,
  /^System\./i,
  /^docx/i,
  /^blocked-file-util/i,
  /^brotli/i,
  /^c_rehash/i,
  /^git-askpass/i,
  /^git-askyesno/i,
  /^scalar/i,
  /^git-http-/i,
  /^git-receive-pack/i,
  /^git-upload-pack/i,
  /^git-sh-i18n/i,
]
for (const name of readdirSync(bin)) {
  if (removePatterns.some((pattern) => pattern.test(name)))
    rmSync(path.join(bin, name), { force: true })
}

/**
 * @param {string} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function git(args, cwd, env) {
  return spawnSync(path.join(bin, 'git.exe'), args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
}

const repo = path.join(work, 'repo')
mkdirSync(repo, { recursive: true })
const env = {
  ...process.env,
  GIT_EXEC_PATH: path.join(lean, 'ucrt64/libexec/git-core'),
  GIT_TEMPLATE_DIR: path.join(lean, 'ucrt64/share/git-core/templates'),
  PATH: `${bin};${path.join(lean, 'cmd')}`,
}
const commands = [
  ['--version'],
  ['init'],
  ['config', 'user.email', 'spike@example.com'],
  ['config', 'user.name', 'Spike'],
  ['config', 'core.autocrlf', 'false'],
  ['add', 'a.txt'],
  ['commit', '-m', 'init'],
  ['status', '--porcelain'],
  ['rev-parse', 'HEAD'],
  ['cat-file', '-p', 'HEAD'],
  ['diff', '--stat', 'HEAD'],
  ['checkout', '--', 'a.txt'],
]
const { writeFileSync } = await import('node:fs')
writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
for (const args of commands) {
  const result = git(args, repo, env)
  results.push({
    args,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}
writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
const diff = git(['diff', '--', 'a.txt'], repo, env)
results.push({
  args: ['diff', '--', 'a.txt'],
  status: diff.status,
  stdout: (diff.stdout ?? '').trim(),
  stderr: (diff.stderr ?? '').trim(),
})
if (!diff.stdout.includes('+changed')) throw new Error('git diff did not show the change')
const checkout = git(['checkout', '--', 'a.txt'], repo, env)
if (checkout.status !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`)
if (readFileSync(path.join(repo, 'a.txt'), 'utf8') !== 'hello\n') {
  throw new Error('git checkout did not restore a.txt')
}

const output = {
  version,
  source: { mirror: url, official: officialUrl },
  archive: { bytes: statSync(archive).size, sha256: actualSha256 },
  extractedBytes: dirSize(full),
  leanBytes: dirSize(lean),
  leanFiles: readdirSync(lean, { recursive: true }).length,
  commands: results,
  license: readFileSync(path.join(lean, 'LICENSE.txt'), 'utf8').slice(0, 80),
}
writeFileSync(path.join(root, 'result-s4.json'), JSON.stringify(output, null, 2))
console.log(
  `MinGit ${version}: archive ${(output.archive.bytes / 1e6).toFixed(1)} MB, extracted ${(
    output.extractedBytes / 1e6
  ).toFixed(1)} MB, lean ${(output.leanBytes / 1e6).toFixed(1)} MB`,
)
console.log(`Commands passed: ${results.length}`)
