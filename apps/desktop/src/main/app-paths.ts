/**
 * 应用数据目录（架构 §14.1）。
 *
 * 正式版放在 `<appData>/Cairn`（Windows 即 `%APPDATA%\Cairn`），开发模式放在
 * `<appData>/Cairn-dev`，避免开发数据污染正式数据。设置 `CAIRN_USER_DATA_DIR` 时直接使用该目录
 * （冒烟测试与自动化测试用）。默认不在用户项目目录里写任何文件。
 */
import { join, resolve } from 'node:path'

export const APP_DIR_NAME = 'Cairn'
export const DEV_APP_DIR_NAME = 'Cairn-dev'
export const USER_DATA_DIR_ENV = 'CAIRN_USER_DATA_DIR'

export interface AppPaths {
  /** 应用数据根目录，同时作为 Electron 的 `userData`。 */
  readonly root: string
  readonly data: string
  readonly database: string
  readonly blobs: string
  readonly checkpoints: string
  readonly settings: string
  /** 加密保存的凭据（M1-03，ADR-0010）。 */
  readonly credentials: string
  readonly logs: string
  /** Chromium 的缓存、Cookie 等（Electron 的 `sessionData`），与应用数据分开。 */
  readonly session: string
}

export interface ResolveAppPathsOptions {
  /** Electron 的 `app.getPath('appData')`。 */
  readonly appData: string
  /** 开发模式（未打包）。 */
  readonly dev: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function resolveAppPaths({ appData, dev, env = {} }: ResolveAppPathsOptions): AppPaths {
  const override = env[USER_DATA_DIR_ENV]?.trim()
  const root = override ? resolve(override) : join(appData, dev ? DEV_APP_DIR_NAME : APP_DIR_NAME)
  const data = join(root, 'data')
  return {
    root,
    data,
    database: join(data, 'cairn.db'),
    blobs: join(data, 'blobs'),
    checkpoints: join(root, 'checkpoints'),
    settings: join(root, 'settings.json'),
    credentials: join(root, 'credentials.json'),
    logs: join(root, 'logs'),
    session: join(root, 'session'),
  }
}

/** 启动时需要存在的目录。 */
export function requiredDirectories(paths: AppPaths): readonly string[] {
  return [paths.root, paths.data, paths.blobs, paths.checkpoints, paths.logs]
}
