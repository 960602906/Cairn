// @ts-check
/**
 * 下载并裁剪随包 MinGit（M5-03，ADR-0008、ADR-0014）。
 *
 * - 固定版本与 SHA256；官方地址失败时回退到 npmmirror 镜像，内容仍以 SHA256 为准。
 * - 解压后按白名单保留检查点需要的目录（`cmd`、`ucrt64/bin`、`libexec/git-core`、模板与许可证），
 *   删除文档、locale、perl、Git Credential Manager、Git LFS 与 HTTP 传输等不需要的部分。
 * - 产物写到 `apps/desktop/resources/git`（gitignore，不提交）；写入前在临时目录验证
 *   `init/add/commit/diff/checkout/rev-parse/cat-file`，任一失败都不会替换现有产物。
 *
 * 用法：node scripts/fetch-mingit.mjs [--force|--check]
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'
import {
  MINGIT_VERSION,
  mingitLayout,
  verifyBundledGit,
} from '../apps/desktop/scripts/bundled-git.mjs'

export {
  MINGIT_VERSION,
  directoryUsage,
  mingitEnv,
  mingitLayout,
  verifyBundledGit,
} from '../apps/desktop/scripts/bundled-git.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

export const MINGIT_SHA256 = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'
export const MINGIT_URLS = [
  `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-${MINGIT_VERSION}-64-bit.zip`,
  `https://npmmirror.com/mirrors/git-for-windows/v2.56.0.windows.4/MinGit-${MINGIT_VERSION}-64-bit.zip`,
]
export const MINGIT_TARGET = path.join(REPO_ROOT, 'apps/desktop/resources/git')
export const MINGIT_CACHE_DIR = path.join(REPO_ROOT, '.cache/mingit')

/** 裁剪后必须保留的条目；路径一律使用 zip 内的正斜杠。 */
export const MINGIT_ALLOWLIST = [
  /^licen[cs]e(?:\.txt)?$/i,
  /^cmd\/[^/]+$/,
  /^(?:ucrt64|mingw64)\/bin\/[^/]+$/,
  /^(?:ucrt64|mingw64)\/libexec\/git-core\/[^/]+$/,
  /^(?:ucrt64|mingw64)\/share\/git-core\/templates\/.+$/,
]

/** 白名单内仍要删除的部分：凭据管理器、HTTP 传输、Scalar/.NET 界面与图形库。 */
export const MINGIT_DENYLIST = [
  /^(?:cmd\/(?:scalar\.exe|git-update-git-for-windows)|(?:ucrt64|mingw64)\/bin\/git-update-git-for-windows)$/,
  /^(?:ucrt64|mingw64)\/bin\/git-(?:credential-[^/]+|askpass|askyesno|remote-http|remote-https|http-[^/]+)(?:\.exe)?$/,
  /^(?:ucrt64|mingw64)\/bin\/(?:blocked-file-util|docx2txt|docx-strip-pii|printf_gettext|printf_ngettext|proxy-lookup|wcurl|scalar)(?:\.exe)?$/,
  /^(?:ucrt64|mingw64)\/bin\/(?:Avalonia|MicroCom|SkiaSharp|HarfBuzzSharp|gcmcore|msalruntime|Microsoft\.|System\.|GitHub|GitLab|Atlassian\.)[^/]*\.dll$/,
  /^(?:ucrt64|mingw64)\/bin\/(?:av_libglesv2|libSkiaSharp|libHarfBuzzSharp)[^/]*\.dll$/,
]

/**
 * @param {Uint8Array} buffer
 * @returns {string}
 */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 校验压缩包；不匹配时抛出并给出实际值，便于升级时定位。
 * @param {Uint8Array} buffer
 * @param {string} [expected]
 */
export function verifyArchive(buffer, expected = MINGIT_SHA256) {
  const actual = sha256Hex(buffer)
  if (actual !== expected) {
    throw new Error(`MinGit archive checksum mismatch: expected ${expected}, got ${actual}`)
  }
  return actual
}

/**
 * zip 条目是否保留，同时拒绝绝对路径与 `..`，避免解压越界。
 * @param {string} name
 * @param {readonly RegExp[]} allowlist
 * @returns {boolean}
 */
export function isPrunedEntryAllowed(name, allowlist = MINGIT_ALLOWLIST) {
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return false
  if (name.split('/').includes('..')) return false
  return (
    allowlist.some((pattern) => pattern.test(name)) &&
    !MINGIT_DENYLIST.some((pattern) => pattern.test(name))
  )
}

/**
 * 过滤 zip 条目；目录条目（以 `/` 结尾）不需要单独保留，写入文件时自动创建父目录。
 * @param {Record<string, Uint8Array>} entries
 * @param {readonly RegExp[]} [allowlist]
 * @returns {{ files: Record<string, Uint8Array>; bytes: number; removed: number }}
 */
export function pruneArchive(entries, allowlist = MINGIT_ALLOWLIST) {
  /** @type {Record<string, Uint8Array>} */
  const files = {}
  let bytes = 0
  let removed = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || !isPrunedEntryAllowed(name, allowlist)) {
      removed++
      continue
    }
    files[name] = data
    bytes += data.byteLength
  }
  return { files, bytes, removed }
}

/**
 * 把裁剪后的条目写到目录；先清空目标，避免旧版本残留。
 * @param {Record<string, Uint8Array>} files
 * @param {string} directory
 */
export function writeArchive(files, directory) {
  rmSync(directory, { recursive: true, force: true })
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(directory, ...name.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
}

/**
 * 下载（或复用缓存）并校验压缩包。
 * @param {{
 *   urls?: readonly string[];
 *   cacheFile?: string;
 *   expected?: string;
 *   force?: boolean;
 *   fetchImpl?: typeof fetch;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function downloadArchive({
  urls = MINGIT_URLS,
  cacheFile = path.join(MINGIT_CACHE_DIR, `MinGit-${MINGIT_VERSION}-64-bit.zip`),
  expected = MINGIT_SHA256,
  force = false,
  fetchImpl = fetch,
  log = () => undefined,
} = {}) {
  if (!force && existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile)
    try {
      verifyArchive(cached, expected)
      log(`mingit: using cached ${cacheFile}`)
      return cached
    } catch (error) {
      log(`mingit: cached archive is invalid (${String(error)}), downloading again`)
    }
  }
  let lastError
  for (const url of urls) {
    try {
      log(`mingit: downloading ${url}`)
      const response = await fetchImpl(url, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = new Uint8Array(await response.arrayBuffer())
      verifyArchive(buffer, expected)
      mkdirSync(path.dirname(cacheFile), { recursive: true })
      writeFileSync(cacheFile, buffer)
      return buffer
    } catch (error) {
      lastError = error
      log(`mingit: ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `cannot download MinGit: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/**
 * 完整流程：下载 → 校验 → 解压 → 裁剪 → 临时目录真实运行 → 替换目标。
 * @param {{
 *   target?: string;
 *   force?: boolean;
 *   archive?: Uint8Array;
 *   expected?: string;
 *   download?: typeof downloadArchive;
 *   verify?: typeof verifyBundledGit;
 *   log?: (line: string) => void;
 * }} [options]
 * @returns {Promise<{ target: string; files: number; bytes: number; version: string }>}
 */
export async function fetchMingit({
  target = MINGIT_TARGET,
  force = false,
  archive,
  expected = MINGIT_SHA256,
  download = downloadArchive,
  verify = verifyBundledGit,
  log = () => undefined,
} = {}) {
  if (archive === undefined && !force && existsSync(mingitLayout(target).binary)) {
    log(`mingit: ${target} already present`)
    return { target, ...verify(target) }
  }
  const zip = archive ?? (await download({ force, log }))
  verifyArchive(zip, expected)
  const { files, bytes, removed } = pruneArchive(unzipSync(zip))
  log(`mingit: ${Object.keys(files).length} files, ${bytes} bytes (removed ${removed} entries)`)
  const staging = mkdtempSync(path.join(tmpdir(), 'cairn-mingit-stage-'))
  try {
    const staged = path.join(staging, 'git')
    writeArchive(files, staged)
    verify(staged)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(staged, target, { recursive: true })
    const result = verify(target)
    return { target, files: result.files, bytes: result.bytes, version: result.version }
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 *   fetch?: typeof fetchMingit;
 *   verify?: typeof verifyBundledGit;
 *   target?: string;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  argv = process.argv.slice(2),
  log = console.log,
  error = console.error,
  fetch: fetchMingitImpl = fetchMingit,
  verify = verifyBundledGit,
  target = MINGIT_TARGET,
} = {}) {
  if (argv.includes('--check')) {
    const result = verify(target)
    log(`mingit: ${result.version} verified at ${target}`)
    return 0
  }
  try {
    const result = await fetchMingitImpl({ force: argv.includes('--force'), log, target })
    log(`mingit: ${MINGIT_VERSION} ready at ${result.target}`)
    return 0
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause))
    return 1
  }
}

/* v8 ignore start -- CLI bootstrap is executed by `pnpm fetch:mingit`. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
/* v8 ignore stop */
