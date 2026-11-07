/**
 * MCP 服务（M3-09，Runtime §21.3，ADR-0017）：配置、状态、工具与日志。
 * 凭据值不在这里传输；只传“已设置 / 未设置”和凭据引用。
 */
import { z } from 'zod'
import { Id, Timestamp } from './common.js'
import { PermissionEffect, ToolCategory } from './permissions.js'

export const McpServerKind = z.enum(['stdio', 'http'])
export type McpServerKind = z.infer<typeof McpServerKind>

export const McpAuthKind = z.enum(['none', 'bearer', 'header'])
export type McpAuthKind = z.infer<typeof McpAuthKind>

export const McpConnectionStatus = z.enum([
  'disabled',
  'connecting',
  'connected',
  'disconnected',
  'error',
])
export type McpConnectionStatus = z.infer<typeof McpConnectionStatus>

/** 环境变量：`credentialRef` 指向凭据服务，配置里不保存值。 */
export const McpEnvEntry = z.object({
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  credentialRef: z.string().min(1),
})
export type McpEnvEntry = z.infer<typeof McpEnvEntry>

/**
 * 添加 / 编辑服务。`env[].value` 是新填入的值：给出时写入凭据服务，省略时保留原有值。
 * `token` 同理；`clearToken` 为 true 时删除已保存的令牌。返回值与事件都不包含这些值。
 */
export const McpServerInput = z
  .object({
    name: z.string().trim().min(1).max(128),
    kind: McpServerKind,
    enabled: z.boolean().optional(),
    /** 本地进程 */
    command: z.string().trim().min(1).max(1024).optional(),
    args: z.array(z.string().max(4096)).max(256).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    env: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          value: z.string().max(8192).optional(),
        }),
      )
      .max(128)
      .optional(),
    /** 远程地址 */
    url: z.string().url().max(4096).optional(),
    auth: McpAuthKind.optional(),
    headerName: z.string().trim().min(1).max(256).optional(),
    token: z.string().min(1).max(8192).optional(),
    clearToken: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'stdio' && !input.command) {
      ctx.addIssue({ code: 'custom', message: 'command is required for stdio servers' })
    }
    if (input.kind === 'http' && !input.url) {
      ctx.addIssue({ code: 'custom', message: 'url is required for http servers' })
    }
    if (input.auth === 'header' && !input.headerName) {
      ctx.addIssue({ code: 'custom', message: 'headerName is required for header auth' })
    }
  })
export type McpServerInput = z.infer<typeof McpServerInput>

export const McpToolSummary = z.object({
  /** 给模型的名称：`服务名.工具名`，只保留 `[a-z0-9_-]`。 */
  name: z.string().min(1),
  /** MCP 服务里的原名。 */
  originalName: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  category: ToolCategory,
  effect: PermissionEffect,
})
export type McpToolSummary = z.infer<typeof McpToolSummary>

export const McpLogEntry = z.object({
  ts: Timestamp,
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
})
export type McpLogEntry = z.infer<typeof McpLogEntry>

export const McpServerSummary = z.object({
  serverId: Id,
  name: z.string().min(1),
  kind: McpServerKind,
  enabled: z.boolean(),
  status: McpConnectionStatus,
  error: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  toolCount: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type McpServerSummary = z.infer<typeof McpServerSummary>

export const McpServerDetail = McpServerSummary.extend({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.array(
    z.object({
      name: z.string().min(1),
      /** 凭据服务中是否已保存这个变量的值。 */
      configured: z.boolean(),
    }),
  ),
  url: z.string().optional(),
  auth: McpAuthKind,
  headerName: z.string().optional(),
  tokenConfigured: z.boolean(),
  tools: z.array(McpToolSummary),
})
export type McpServerDetail = z.infer<typeof McpServerDetail>

/** 交给宿主的 MCP 工具定义（`host.init.mcpTools`）。 */
export const McpToolExposure = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  serverId: Id,
  originalName: z.string().min(1),
  category: ToolCategory,
})
export type McpToolExposure = z.infer<typeof McpToolExposure>

/** 状态的推送（`mcp.status`）。 */
export const McpStatusEvent = z.object({
  serverId: Id,
  status: McpConnectionStatus,
  error: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  toolCount: z.number().int().nonnegative(),
})
export type McpStatusEvent = z.infer<typeof McpStatusEvent>
