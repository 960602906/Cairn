/**
 * Git 定位（M5-03，ADR-0008）：优先本机 Git（≥ 2.32），不可用时使用随包的裁剪版 MinGit。
 *
 * - 只探测一次并缓存结果；检查点、改动集、隔离工作区与宿主共用同一个定位结果。
 * - `CAIRN_GIT_BINARY` 强制使用指定可执行文件（测试与诊断）；`CAIRN_GIT_DISABLE_BUNDLED=1`
 *   关闭随包兜底，用于验证“本机 Git 优先”与“都不可用”两种降级路径。
 * - 随包 MinGit 需要受控的 `GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR` 与 `PATH`（同目录 DLL），
 *   由这里统一给出，不接受用户环境中的同名变量。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createGitRunner, detectGit, type GitDetection } from '@cairn/checkpoint'
import type { GitRuntimeInfo } from '@cairn/protocol'

export const GIT_BINARY_ENV = 'CAIRN_GIT_BINARY'
export const GIT_DISABLE_BUNDLED_ENV = 'CAIRN_GIT_DISABLE_BUNDLED'

export type GitSource = 'system' | 'bundled' | 'unavailable'

export interface AvailableGit {
  readonly available: true
  readonly source: 'system' | 'bundled'
  readonly binary: string
  readonly version: string
  /** 随包 MinGit 的受控环境变量；本机 Git 没有。 */
  readonly env?: Readonly<Record<string, string>>
}

export interface UnavailableGit {
  readonly available: false
  readonly source: 'unavailable'
  readonly reason: 'not_found' | 'too_old' | 'unrecognized'
  readonly version?: string
}

export type GitLocation = AvailableGit | UnavailableGit

export interface BundledGitLayout {
  readonly binary: string
  readonly execPath: string
  readonly templateDir: string
  readonly binDir: string
}

export interface GitLocatorOptions {
  /** 随包 Git 根目录（开发态 `resources/git`，安装版 `<resources>/git`）。 */
  readonly bundledDir: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  /** 测试用：替换 Git 探测（默认执行 `<binary> --version`）。 */
  readonly detect?: (binary: string) => Promise<GitDetection>
  readonly exists?: (file: string) => boolean
}

/**
 * 随包 MinGit 的目录布局。2.56 的 MinGit 使用 `ucrt64`；保留 `mingw64` 作为未来布局变化的兜底。
 * 目录或入口不存在时返回 undefined 并跳过随包候选。
 */
export function bundledGitLayout(
  directory: string,
  exists: (file: string) => boolean = existsSync,
): BundledGitLayout | undefined {
  for (const prefix of ['ucrt64', 'mingw64']) {
    const binDir = join(directory, prefix, 'bin')
    const binary = join(binDir, 'git.exe')
    const execPath = join(directory, prefix, 'libexec/git-core')
    const templateDir = join(directory, prefix, 'share/git-core/templates')
    if (exists(binary) && exists(execPath)) {
      return { binary, execPath, templateDir, binDir }
    }
  }
  return undefined
}

/** 随包 MinGit 的受控环境变量；`PATH` 只前置它的 bin 目录。 */
export function bundledGitEnv(
  layout: BundledGitLayout,
  base: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const separator = platform === 'win32' ? ';' : ':'
  const inherited = base['PATH']
  return {
    PATH: inherited ? `${layout.binDir}${separator}${inherited}` : layout.binDir,
    GIT_EXEC_PATH: layout.execPath,
    GIT_TEMPLATE_DIR: layout.templateDir,
  }
}

const defaultDetect = (binary: string): Promise<GitDetection> =>
  detectGit(createGitRunner({ binary, env: {} }))

/** 缓存定位结果的定位器；定位开始时只探测一次。 */
export interface GitLocator {
  locate(): Promise<GitLocation>
  /** 已经定位过时返回缓存结果，否则 undefined。 */
  cached(): GitLocation | undefined
}

export function createGitLocator(options: GitLocatorOptions): GitLocator {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const detect = options.detect ?? defaultDetect
  let cached: GitLocation | undefined
  let pending: Promise<GitLocation> | undefined

  const locateOnce = async (): Promise<GitLocation> => {
    const override = env[GIT_BINARY_ENV]?.trim()
    if (override) {
      const detection = await detect(override)
      if (detection.available) {
        return { available: true, source: 'system', binary: override, version: detection.version }
      }
      return {
        available: false,
        source: 'unavailable',
        reason: detection.reason,
        ...(detection.version !== undefined ? { version: detection.version } : {}),
      }
    }

    const system = await detect('git')
    if (system.available) {
      return { available: true, source: 'system', binary: 'git', version: system.version }
    }

    const layout =
      env[GIT_DISABLE_BUNDLED_ENV] === '1'
        ? undefined
        : bundledGitLayout(options.bundledDir, exists)
    if (layout) {
      const bundled = await detect(layout.binary)
      if (bundled.available) {
        return {
          available: true,
          source: 'bundled',
          binary: layout.binary,
          version: bundled.version,
          env: bundledGitEnv(layout, env, platform),
        }
      }
      return {
        available: false,
        source: 'unavailable',
        reason: bundled.reason,
        ...(bundled.version !== undefined ? { version: bundled.version } : {}),
      }
    }

    return {
      available: false,
      source: 'unavailable',
      reason: system.reason,
      ...(system.version !== undefined ? { version: system.version } : {}),
    }
  }

  return {
    locate() {
      pending ??= locateOnce().then(
        (location) => {
          cached = location
          return location
        },
        (error: unknown) => {
          pending = undefined
          throw error
        },
      )
      return pending
    },
    cached: () => cached,
  }
}

/** 关于页与诊断包使用的摘要（不含路径）。 */
export function gitRuntimeInfo(location: GitLocation): GitRuntimeInfo {
  if (location.available) return { source: location.source, version: location.version }
  return {
    source: location.source,
    reason: location.reason,
    ...(location.version !== undefined ? { version: location.version } : {}),
  }
}
