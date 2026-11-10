// @ts-check
/**
 * 发布上传与公开可下载校验（M5-08）。
 *
 * 两种上传方式：
 * - `github`：`gh release create/upload`，适合 public release-only 仓库过渡；客户端更新源需要
 *   固定目录，因此正式 stable/beta 仍建议对象存储（`rclone`）。
 * - `rclone`：把产物同步到静态源远端（S3/R2/兼容存储），凭据由 CI secrets 提供。
 *
 * 上传后必须从公开 URL 重新下载全部文件并核对 SHA-256；校验失败时发布判为失败，由人工撤包。
 * 脚本不读取也不打印证书、密码或上传令牌。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PUBLISH_METHODS = ['github', 'rclone']

/**
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * GitHub Release 资产下载地址（匿名可访问）。
 * @param {{ serverUrl: string; repo: string; tag: string }} input
 * @returns {string}
 */
export function githubDownloadBase({ serverUrl, repo, tag }) {
  return `${serverUrl.replace(/\/+$/, '')}/${repo}/releases/download/${encodeURIComponent(tag)}/`
}

/**
 * @param {{
 *   tag: string;
 *   directory: string;
 *   notesFile: string;
 *   channel: 'stable' | 'beta';
 *   repo: string;
 * }} input
 * @returns {string[][]}
 */
export function githubReleaseCommands({ tag, directory, notesFile, channel, repo }) {
  const files = listFiles(directory)
  return [
    [
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--title',
      `Cairn ${tag.replace(/^v/, '')}`,
      '--notes-file',
      notesFile,
      ...(channel === 'beta' ? ['--prerelease'] : []),
    ],
    ['release', 'upload', tag, ...files, '--repo', repo, '--clobber'],
  ]
}

/**
 * @param {{ directory: string; remote: string }} input
 * @returns {string[]}
 */
export function rcloneCommand({ directory, remote }) {
  return ['copy', directory, remote, '--checksum']
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
export function listFiles(directory) {
  return readdirSyncSorted(directory)
    .filter((name) => existsSync(path.join(directory, name)))
    .map((name) => path.join(directory, name))
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function readdirSyncSorted(directory) {
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    throw new Error(
      `cannot read release directory ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  return names.sort()
}

/**
 * 从公开地址重新下载并核对 SHA-256；返回问题列表。
 * @param {{
 *   baseUrl: string;
 *   directory: string;
 *   files?: readonly string[];
 *   fetchImpl?: typeof fetch;
 *   attempts?: number;
 * }} options
 * @returns {Promise<string[]>}
 */
export async function verifyPublishedArtifacts({
  baseUrl,
  directory,
  files = listFiles(directory),
  fetchImpl = fetch,
  attempts = 6,
}) {
  const problems = []
  for (const file of files) {
    const name = path.basename(file)
    const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
    let lastError = ''
    let verified = false
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, { redirect: 'follow' })
        if (!response.ok) {
          lastError = `HTTP ${response.status}`
        } else {
          const body = Buffer.from(await response.arrayBuffer())
          const actual = createHash('sha256').update(body).digest('hex')
          if (actual !== sha256(file)) {
            problems.push(`${name} downloaded from ${url} does not match its SHA-256`)
            verified = true
          } else {
            verified = true
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      if (verified) break
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    if (!verified) problems.push(`${name} is not publicly downloadable from ${url}: ${lastError}`)
  }
  return problems
}

/**
 * @param {{
 *   method: 'github' | 'rclone';
 *   tag: string;
 *   directory: string;
 *   notesFile: string;
 *   channel: 'stable' | 'beta';
 *   repo: string;
 *   remote?: string | undefined;
 *   verifyBaseUrl: string;
 *   runner?: typeof spawnSync;
 *   verify?: typeof verifyPublishedArtifacts;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} options
 * @returns {Promise<number>}
 */
export async function publishRelease({
  method,
  tag,
  directory,
  notesFile,
  channel,
  repo,
  remote,
  verifyBaseUrl,
  runner = spawnSync,
  verify = verifyPublishedArtifacts,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
}) {
  if (!PUBLISH_METHODS.includes(method)) {
    error(`publish: unsupported method ${method}`)
    return 1
  }
  if (!existsSync(directory)) {
    error(`publish: release directory not found: ${directory}`)
    return 1
  }
  if (!existsSync(notesFile)) {
    error(`publish: release notes not found: ${notesFile}`)
    return 1
  }
  /**
   * @param {string} command
   * @param {string[]} args
   * @param {string} name
   */
  const run = (command, args, name) => {
    log(`publish: ${name}`)
    const result = runner(command, args, { stdio: 'inherit', windowsHide: true, shell: false })
    if (result.status !== 0) {
      throw new Error(`${name} failed with ${result.status ?? result.signal}`)
    }
  }
  try {
    if (method === 'github') {
      const commands = githubReleaseCommands({
        tag,
        directory,
        notesFile,
        channel,
        repo,
      })
      const [createArgs, uploadArgs] = commands
      if (createArgs === undefined || uploadArgs === undefined) {
        throw new Error('github release commands are incomplete')
      }
      const created = runner('gh', createArgs, { stdio: 'inherit', windowsHide: true })
      if (created.status === 0) {
        run('gh', uploadArgs, 'uploading GitHub release assets')
      } else {
        log('publish: release already exists; editing notes and re-uploading assets')
        run(
          'gh',
          ['release', 'edit', tag, '--repo', repo, '--notes-file', notesFile],
          'updating GitHub release notes',
        )
        run('gh', uploadArgs, 'uploading GitHub release assets')
      }
    } else {
      if (remote === undefined || remote.trim() === '') {
        throw new Error('CAIRN_UPLOAD_REMOTE is required for rclone publishing')
      }
      run('rclone', rcloneCommand({ directory, remote }), 'uploading to the static update source')
    }

    log(`publish: verifying public downloads from ${verifyBaseUrl}`)
    const problems = await verify({ baseUrl: verifyBaseUrl, directory })
    if (problems.length > 0) {
      for (const problem of problems) error(`publish: ${problem}`)
      return 1
    }
    const bytes = listFiles(directory).reduce((total, file) => total + statSync(file).size, 0)
    log(`publish: ${listFiles(directory).length} files, ${bytes} bytes uploaded and verified`)
    return 0
  } catch (failure) {
    error(`publish: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   env?: Readonly<Record<string, string | undefined>>;
 *   runner?: typeof spawnSync;
 *   verify?: typeof verifyPublishedArtifacts;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  runner = spawnSync,
  verify = verifyPublishedArtifacts,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  /** @param {string} flag */
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const dryRun = argv.includes('--dry-run')
  const method = value('--method') ?? 'github'
  const tag = value('--tag')
  const directory = value('--dir')
  const channel = value('--channel') ?? 'beta'
  const repo = value('--repo') ?? env['GITHUB_REPOSITORY'] ?? ''
  const remote = value('--remote') ?? env['CAIRN_UPLOAD_REMOTE']
  const notesFile =
    value('--notes') ?? (directory ? path.join(directory, 'release-notes.md') : undefined)
  if (tag === undefined || directory === undefined || notesFile === undefined) {
    error('usage: publish-release.mjs --tag <vX.Y.Z> --dir <release> [--method github|rclone]')
    return 1
  }
  if (channel !== 'stable' && channel !== 'beta') {
    error('--channel must be stable or beta')
    return 1
  }
  if (method !== 'github' && method !== 'rclone') {
    error('--method must be github or rclone')
    return 1
  }
  const serverUrl = env['GITHUB_SERVER_URL'] ?? 'https://github.com'
  const verifyBaseUrl =
    value('--verify-base-url') ??
    (method === 'github' && repo !== '' ? githubDownloadBase({ serverUrl, repo, tag }) : '')
  if (dryRun) {
    log(`publish: dry run; ${listFiles(directory).length} files would be uploaded (${method})`)
    if (verifyBaseUrl !== '') log(`publish: would verify downloads from ${verifyBaseUrl}`)
    return 0
  }
  if (verifyBaseUrl === '') {
    error('--verify-base-url is required so the release can be re-downloaded anonymously')
    return 1
  }
  return publishRelease({
    method,
    tag,
    directory,
    notesFile,
    channel,
    repo,
    remote,
    verifyBaseUrl,
    runner,
    verify,
    log,
    error,
  })
}

/* v8 ignore start -- CLI bootstrap is executed by the release workflow, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
/* v8 ignore stop */
