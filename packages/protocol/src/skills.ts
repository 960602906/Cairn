/**
 * 技能（M3-07，Runtime §21.2，ADR-0017）。
 * 界面管理技能，宿主每轮读取已启用的技能索引。
 */
import { z } from 'zod'
import { Id } from './common.js'

export const SkillSource = z.enum(['builtin', 'user', 'project'])
export type SkillSource = z.infer<typeof SkillSource>

/** 附带文件。`SKILL.md` 本身不在这里。 */
export const SkillFileInfo = z.object({
  /** 相对技能目录，`/` 分隔。 */
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  script: z.boolean(),
})
export type SkillFileInfo = z.infer<typeof SkillFileInfo>

export const SkillSummary = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: SkillSource,
  /** 项目内技能所属的项目。内置和已安装的技能没有。 */
  projectId: Id.optional(),
  enabled: z.boolean(),
  /** 每轮把正文放进系统提示词。 */
  pinned: z.boolean(),
  /** 同名的另一份技能优先级更高，这份不会交给模型。 */
  shadowed: z.boolean(),
  hasScripts: z.boolean(),
  /** 附带文件太多，`files` 只保留了一部分。 */
  filesTruncated: z.literal(true).optional(),
  files: z.array(SkillFileInfo),
})
export type SkillSummary = z.infer<typeof SkillSummary>

export const SkillDetail = SkillSummary.extend({
  /** `SKILL.md` 原文。 */
  markdown: z.string(),
  /** 头部之后的正文。 */
  body: z.string(),
})
export type SkillDetail = z.infer<typeof SkillDetail>

/** 交给 `read_file` 的路径：工作区内用相对路径，否则用绝对路径。 */
export const SkillCatalogFile = SkillFileInfo.extend({
  readPath: z.string().min(1),
})
export type SkillCatalogFile = z.infer<typeof SkillCatalogFile>

/** 宿主一轮里能用的一份技能。只包含已启用、且没有被同名技能盖住的。 */
export const SkillCatalogEntry = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: SkillSource,
  pinned: z.boolean(),
  /** 技能目录的绝对路径。`read_file` 可以读这里，不能写。 */
  root: z.string().min(1),
  body: z.string(),
  hasScripts: z.boolean(),
  filesTruncated: z.literal(true).optional(),
  files: z.array(SkillCatalogFile),
})
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntry>

export const SkillInstallSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory'), path: z.string().min(1) }),
  z.object({ kind: z.literal('zip'), path: z.string().min(1) }),
])
export type SkillInstallSource = z.infer<typeof SkillInstallSource>
