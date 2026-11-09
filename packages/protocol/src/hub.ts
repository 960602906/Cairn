/** 资源市场（技能 / MCP）的只读目录卡片。安装动作仍走各自的 install / add 接口。 */
import { z } from 'zod'

export const HubSkillCard = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  summary: z.string(),
  ownerHandle: z.string().optional(),
  version: z.string().optional(),
  downloads: z.number().int().nonnegative(),
  stars: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative().optional(),
  webUrl: z.string().url().optional(),
  downloadUrl: z.string().url().optional(),
})
export type HubSkillCard = z.infer<typeof HubSkillCard>

export const HubMcpCard = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  version: z.string().optional(),
  transport: z.enum(['http', 'stdio']),
  url: z.string().url().optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  /** 远端要求 Authorization 等必填请求头，需要在表单里补全后才能连接。 */
  requiresAuth: z.boolean(),
})
export type HubMcpCard = z.infer<typeof HubMcpCard>
