// @ts-check
/**
 * 发布标签与版本一致性检查（M5-08）：标签 `v*` 必须与根 `package.json` 版本一致，
 * 预发布标签只能进 beta，stable 必须是无预发布后缀的正式版本。
 *
 * 用法：node scripts/check-release-tag.mjs [--tag v0.1.1] [--channel stable|beta]
 *       [--github-output <file>]
 * 默认从 `GITHUB_REF_NAME` 读取标签；本地可显式传 `--tag`。
 */
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readVersion } from './sync-version.mjs'

const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

/**
 * @param {string} version
 * @param {'stable' | 'beta' | undefined} requested
 * @returns {'stable' | 'beta'}
 */
export function resolveReleaseChannel(version, requested) {
  if (requested === 'stable' || requested === 'beta') return requested
  return version.includes('-') || version.startsWith('0.') ? 'beta' : 'stable'
}

/**
 * @param {{ tag: string; version: string; requestedChannel?: 'stable' | 'beta' | undefined }} input
 * @returns {{ version: string; channel: 'stable' | 'beta'; prerelease: boolean }}
 */
export function checkReleaseTag({ tag, version, requestedChannel }) {
  const match = TAG_PATTERN.exec(tag.trim())
  if (match === null) throw new Error(`release tag must look like vX.Y.Z: ${tag}`)
  const tagVersion = match[1]
  if (tagVersion !== version) {
    throw new Error(`release tag ${tag} does not match package.json version ${version}`)
  }
  const prerelease = tagVersion.includes('-')
  const channel = resolveReleaseChannel(tagVersion, requestedChannel)
  if (channel === 'stable' && prerelease) {
    throw new Error('stable releases must not use a prerelease tag')
  }
  return { version: tagVersion, channel, prerelease }
}

/**
 * @param {{
 *   argv?: readonly string[];
 *   env?: Readonly<Record<string, string | undefined>>;
 *   root?: string;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  root = path.resolve(import.meta.dirname, '..'),
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  /** @param {string} flag */
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const tag = value('--tag') ?? env['GITHUB_REF_NAME']
  if (tag === undefined || tag.trim() === '') {
    error('usage: check-release-tag.mjs --tag vX.Y.Z [--channel stable|beta]')
    return 1
  }
  const requested = value('--channel')
  if (requested !== undefined && requested !== 'stable' && requested !== 'beta') {
    error('--channel must be stable or beta')
    return 1
  }
  try {
    const result = checkReleaseTag({
      tag,
      version: readVersion(path.join(root, 'package.json')),
      requestedChannel: requested,
    })
    const githubOutput = value('--github-output')
    if (githubOutput !== undefined && githubOutput !== '') {
      appendFileSync(githubOutput, `version=${result.version}\nchannel=${result.channel}\n`)
    }
    log(`release: tag ${tag} -> ${result.version} (${result.channel})`)
    return 0
  } catch (failure) {
    error(`release: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

/* v8 ignore start -- CLI bootstrap is executed by the release workflow, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
/* v8 ignore stop */
