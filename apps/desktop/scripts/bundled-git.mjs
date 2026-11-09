// @ts-check
/**
 * 随包 MinGit 的布局、受控环境与真实 Git 冒烟（M5-03，ADR-0008）。
 *
 * 仓库根的 `scripts/fetch-mingit.mjs` 在下载/裁剪后调用这里的验证；打包与安装冒烟也用它
 * 确认安装目录里的 MinGit 能真正运行。布局必须与主进程的 `git-locator.ts` 保持一致
 *（测试会核对）。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 固定版本；升级时同步 `scripts/fetch-mingit.mjs` 的 URL 与 SHA256。 */
export const MINGIT_VERSION = '2.56.0.4'

/**
 * 随包 MinGit 的目录布局。2.56 使用 `ucrt64`；保留 `mingw64` 作为未来布局变化的兜底。
 * @param {string} directory
 * @returns {{ binary: string, execPath: string, templateDir: string, binDir: string }}
 */
export function mingitLayout(directory) {
  const prefix = existsSync(path.join(directory, 'ucrt64')) ? 'ucrt64' : 'mingw64'
  const binDir = path.join(directory, prefix, 'bin')
  return {
    binary: path.join(binDir, 'git.exe'),
    execPath: path.join(directory, prefix, 'libexec/git-core'),
    templateDir: path.join(directory, prefix, 'share/git-core/templates'),
    binDir,
  }
}

/**
 * 随包 MinGit 的受控环境变量（与 `git-locator.ts` 的 `bundledGitEnv` 一致）。
 * @param {{ binDir: string; execPath: string; templateDir: string }} layout
 * @param {Readonly<Record<string, string | undefined>>} base
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function mingitEnv(layout, base, platform = process.platform) {
  const separator = platform === 'win32' ? ';' : ':'
  const inherited = base['PATH']
  return {
    PATH: inherited ? `${layout.binDir}${separator}${inherited}` : layout.binDir,
    GIT_EXEC_PATH: layout.execPath,
    GIT_TEMPLATE_DIR: layout.templateDir,
  }
}

/**
 * 在不依赖用户 Git 环境的前提下执行真实 Git 操作；只检查 `--version` 不算通过。
 * @param {string} directory
 * @param {{
 *   base?: Readonly<Record<string, string | undefined>>;
 *   platform?: NodeJS.Platform;
 *   run?: (file: string, args: string[], options: { cwd: string; env: Record<string, string> }) => string;
 * }} [options]
 * @returns {{ version: string; files: number; bytes: number }}
 */
export function verifyBundledGit(directory, { base = process.env, platform, run } = {}) {
  const layout = mingitLayout(directory)
  if (!existsSync(layout.binary)) throw new Error(`bundled git is missing: ${layout.binary}`)
  /** @type {Record<string, string>} */
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value
  }
  Object.assign(env, mingitEnv(layout, base, platform))
  const execute =
    run ??
    ((file, args, options) =>
      execFileSync(file, args, {
        ...options,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim())
  const version = execute(layout.binary, ['--version'], { cwd: directory, env })
  if (!version.includes(`git version ${MINGIT_VERSION.split('.').slice(0, 3).join('.')}`)) {
    throw new Error(`unexpected bundled git version: ${version}`)
  }

  const repo = mkdtempSync(path.join(tmpdir(), 'cairn-mingit-'))
  try {
    /** @param {string[]} args */
    const git = (args) =>
      execute(layout.binary, ['-c', 'safe.directory=*', ...args], { cwd: repo, env })
    git(['init', '-q'])
    git(['config', 'user.name', 'Cairn'])
    git(['config', 'user.email', 'cairn@example.invalid'])
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'initial'])
    const commit = git(['rev-parse', 'HEAD'])
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('bundled git rev-parse failed')
    if (!git(['cat-file', '-p', 'HEAD']).includes('tree ')) {
      throw new Error('bundled git cat-file failed')
    }
    writeFileSync(path.join(repo, 'a.txt'), 'two\n')
    if (!git(['diff', '--stat']).includes('a.txt')) throw new Error('bundled git diff failed')
    git(['checkout', '--', 'a.txt'])
    if (readFileSync(path.join(repo, 'a.txt'), 'utf8') !== 'one\n') {
      throw new Error('bundled git checkout failed')
    }
    // status 必须能执行；有输出时也正常（例如模板目录生成的文件）。
    git(['status', '--porcelain'])
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  const { files, bytes } = directoryUsage(directory)
  return { version, files, bytes }
}

/**
 * 目录中的文件数与字节数；用于记录裁剪后体积。
 * @param {string} directory
 * @returns {{ files: number; bytes: number }}
 */
export function directoryUsage(directory) {
  let files = 0
  let bytes = 0
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(file)
      } else if (entry.isFile()) {
        files++
        bytes += statSync(file).size
      }
    }
  }
  walk(directory)
  return { files, bytes }
}
