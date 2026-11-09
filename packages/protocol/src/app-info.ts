/**
 * 应用版本与构建信息（M5-01）：关于页、诊断包与发布元数据共用同一份结构。
 *
 * `BuildInfo` 是构建时写入 `out/build-info.json` 的内容；`AppInfo` 在主进程补充应用身份、
 * 是否安装版以及数据库 schema 版本后提供给界面。两者都不包含用户路径、凭据或项目内容。
 */
import { z } from 'zod'

/** 更新通道（ADR-0036）。 */
export const BuildChannel = z.enum(['stable', 'beta'])
export type BuildChannel = z.infer<typeof BuildChannel>

export const BuildInfo = z.object({
  /** 构建信息文件自身的格式版本。 */
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  channel: BuildChannel,
  /** 构建提交的完整 SHA；无法获取时为 `unknown`。 */
  commit: z.string().regex(/^([0-9a-f]{7,40}|unknown)$/),
  /** ISO 8601 构建时间；无法获取时为空串。 */
  buildTime: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?$/),
  electronVersion: z.string().regex(/^[0-9A-Za-z.+-]*$/),
  nodeVersion: z.string().regex(/^[0-9A-Za-z.+-]*$/),
})
export type BuildInfo = z.infer<typeof BuildInfo>

export const AppInfo = BuildInfo.extend({
  /** 产品名（`Cairn`）。 */
  name: z.string().min(1),
  /** 应用标识（`com.cairn.desktop`）。 */
  appId: z.string().min(1),
  copyright: z.string(),
  /** 是否为安装版；开发模式为 false。 */
  packaged: z.boolean(),
  /** 当前应用支持的数据库 schema 版本。 */
  databaseSchemaVersion: z.number().int().nonnegative(),
})
export type AppInfo = z.infer<typeof AppInfo>
