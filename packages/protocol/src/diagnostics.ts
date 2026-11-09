/**
 * 诊断包协议（M3-13，架构 §20、§21）：脱敏导出清单与结果。
 */
import { z } from 'zod'
import { AppInfo } from './app-info.js'

export const DiagnosticsExportInput = z.object({
  sessionId: z.string().optional(),
  includeSensitiveSessionContent: z.boolean().default(false),
})
/** 入参类型：勾选项可省略，默认不包含会话正文。 */
export type DiagnosticsExportInput = z.input<typeof DiagnosticsExportInput>

export const DiagnosticsSessionSummary = z.object({
  sessionId: z.string(),
  title: z.string(),
  eventsCount: z.number(),
  includeSensitiveContent: z.boolean(),
})
export type DiagnosticsSessionSummary = z.infer<typeof DiagnosticsSessionSummary>

export const DiagnosticsSummary = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  /** 版本、通道、提交与数据库 schema 版本（M5-01）。 */
  build: AppInfo,
  platform: z.string(),
  arch: z.string(),
  logs: z.object({
    mainLogLines: z.number(),
    hostLogLines: z.number(),
  }),
  settings: z.object({
    providersCount: z.number(),
    mcpServersCount: z.number(),
    hasAuxiliaryModel: z.boolean(),
  }),
  session: DiagnosticsSessionSummary.optional(),
  exportItems: z.array(z.string()),
})
export type DiagnosticsSummary = z.infer<typeof DiagnosticsSummary>

export const DiagnosticsExportResult = z.object({
  path: z.string().optional(),
  cancelled: z.boolean().default(false),
})
export type DiagnosticsExportResult = z.infer<typeof DiagnosticsExportResult>
