// 以子进程调用 Git（本机 Git 或随应用打包的 Git），与用户的 Git 配置和环境隔离。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 去掉继承的 GIT_* 环境变量（如 GIT_DIR、GIT_INDEX_FILE 会让命令作用到别的仓库），
 * 并屏蔽系统级与用户级配置：用户的 autocrlf、钩子、签名、LFS 过滤器等都不应影响检查点。
 */
export function isolatedEnv(extra, emptyConfigFile) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  Object.assign(env, extra, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfigFile,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  })
  return env
}

export function createGitRunner({ binary, env }) {
  let processes = 0
  const run = (args, { cwd, stdin, allowFail = false } = {}) =>
    new Promise((resolve, reject) => {
      processes++
      const t0 = performance.now()
      const child = spawn(binary, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      const out = []
      const err = []
      child.stdout.on('data', (c) => out.push(c))
      child.stderr.on('data', (c) => err.push(c))
      child.on('error', reject)
      child.on('close', (code) => {
        const result = {
          code,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
          ms: performance.now() - t0,
        }
        if (code !== 0 && !allowFail) {
          reject(new Error(`git ${args.join(' ')} → ${code}: ${result.stderr.trim()}`))
        } else resolve(result)
      })
      if (child.stdin) {
        child.stdin.on('error', () => {})
        child.stdin.end(stdin)
      }
    })
  return {
    binary,
    run,
    text: async (args, opts) => (await run(args, opts)).stdout.toString('utf8').trim(),
    get processes() {
      return processes
    },
  }
}

/** 本机 Git：PATH 中的 git。 */
export function systemGit(stateDir) {
  return createGitRunner({ binary: 'git', env: isolatedEnv({}, emptyConfig(stateDir)) })
}

/** 随应用打包的 Git：dugite 自带的 Git 发行版（Windows 上基于 Git for Windows）。 */
export async function bundledGit(stateDir) {
  const { setupEnvironment } = await import('dugite')
  const { env, gitLocation } = setupEnvironment({}, isolatedEnv({}, emptyConfig(stateDir)))
  // setupEnvironment 在 Linux / macOS 上把 GIT_CONFIG_SYSTEM 指向自带的配置；这里统一屏蔽系统级配置。
  delete env.GIT_CONFIG_SYSTEM
  env.GIT_CONFIG_NOSYSTEM = '1'
  return createGitRunner({ binary: gitLocation, env })
}

function emptyConfig(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'empty.gitconfig')
  fs.writeFileSync(file, '')
  return file
}
