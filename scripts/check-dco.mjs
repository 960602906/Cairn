// @ts-check
/**
 * DCO 校验（M6-07，ADR-0039）：PR 中的每个非合并提交都必须带与作者一致的
 * `Signed-off-by:` 行。CI 在 `pull_request` 上运行；本地可显式传 `--base <sha>`。
 *
 * 用法：node scripts/check-dco.mjs --base <sha> [--head HEAD]
 *      默认从 `GITHUB_BASE_SHA` 读取 base。
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const FIELD = '\u001f'
const RECORD = '\u001e'
const SIGNOFF = /^Signed-off-by:\s*(.+?)\s*<([^<>]+)>\s*$/gim

/**
 * 提取提交消息中的全部 DCO 签署行。
 * @param {string} message
 * @returns {{ name: string; email: string }[]}
 */
export function signoffs(message) {
  return [...message.matchAll(SIGNOFF)].map((match) => ({
    name: (match[1] ?? '').trim(),
    email: (match[2] ?? '').trim().toLowerCase(),
  }))
}

/**
 * 作者是否在提交消息中签署了 DCO。姓名与邮箱都必须一致；邮箱大小写不敏感。
 * @param {{ message: string; authorName: string; authorEmail: string }} input
 * @returns {boolean}
 */
export function hasSignoff({ message, authorName, authorEmail }) {
  const expectedName = authorName.trim()
  const expectedEmail = authorEmail.trim().toLowerCase()
  return signoffs(message).some(
    (entry) => entry.name === expectedName && entry.email === expectedEmail,
  )
}

/**
 * @typedef {{ hash: string; authorName: string; authorEmail: string; message: string }} Commit
 */

/**
 * @param {readonly Commit[]} commits
 * @returns {string[]}
 */
export function checkCommits(commits) {
  return commits
    .filter(
      (commit) =>
        !hasSignoff({
          message: commit.message,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
        }),
    )
    .map((commit) => {
      const subject = commit.message.split(/\r?\n/, 1)[0]?.trim() ?? ''
      return `${commit.hash.slice(0, 12)} ${subject}: missing Signed-off-by: ${commit.authorName} <${commit.authorEmail}>`
    })
}

/**
 * 解析 `git log --format=%H%x1f%an%x1f%ae%x1f%B%x1e` 的输出。
 * @param {string} output
 * @returns {Commit[]}
 */
export function parseLog(output) {
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [hash = '', authorName = '', authorEmail = '', ...rest] = record.split(FIELD)
      return { hash, authorName, authorEmail, message: rest.join(FIELD) }
    })
}

/**
 * @param {{
 *   base: string;
 *   head?: string;
 *   runner?: typeof spawnSync;
 * }} options
 * @returns {Commit[]}
 */
export function commitsInRange({ base, head = 'HEAD', runner = spawnSync }) {
  const result = runner(
    'git',
    [
      'log',
      '--no-merges',
      `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`,
      `${base}..${head}`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0) {
    throw new Error(`git log failed: ${String(result.stderr ?? '').trim()}`)
  }
  return parseLog(String(result.stdout ?? ''))
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   env?: Readonly<Record<string, string | undefined>>;
 *   runner?: typeof spawnSync;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  runner = spawnSync,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  /** @param {string} flag */
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const base = value('--base') ?? env['GITHUB_BASE_SHA']
  const head = value('--head') ?? 'HEAD'
  if (base === undefined || base.trim() === '') {
    error('usage: check-dco.mjs --base <sha> [--head HEAD]')
    return 1
  }
  try {
    const commits = commitsInRange({ base, head, runner })
    const problems = checkCommits(commits)
    if (problems.length > 0) {
      for (const problem of problems) error(`dco: ${problem}`)
      error('dco: every commit needs a matching Signed-off-by line (see CONTRIBUTING.md)')
      return 1
    }
    log(`dco: ${commits.length} commits signed off`)
    return 0
  } catch (failure) {
    error(`dco: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

/* v8 ignore start -- CLI bootstrap is executed by CI, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
/* v8 ignore stop */
