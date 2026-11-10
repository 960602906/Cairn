/**
 * 诊断包服务（M3-13，架构 §20、§21）：脱敏导出系统信息、设置摘要、运行日志与会话记录。
 *
 * 硬约束：
 * 1. API Key、MCP 令牌、用户主目录真实路径严禁出现在诊断包中。
 * 2. 使用 fflate 进行 zip 压缩打包。
 * 3. 默认不含会话消息正文与工具输入内容，需显式勾选才包含。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { z } from 'zod'
import type {
  AppInfo,
  DiagnosticsExportInput,
  DiagnosticsExportResult,
  DiagnosticsSummary,
  MainForRenderer,
  SandboxStatus,
  UpdateDiagnostics,
} from '@cairn/protocol'

type Requests = (typeof MainForRenderer)['requests']
type Handler<M extends keyof Requests> = (
  params: z.output<Requests[M]['params']>,
) => z.input<Requests[M]['result']> | Promise<z.input<Requests[M]['result']>>

/** 由诊断服务实现的 RPC 命令（M3-13）。 */
export interface DiagnosticsCommands {
  readonly summary: Handler<'diagnostics.summary'>
  readonly export: Handler<'diagnostics.export'>
  readonly showInFolder: Handler<'diagnostics.showInFolder'>
}

export interface DiagnosticsDeps {
  /** 关于页、诊断清单与诊断包共用的构建信息（M5-01）。 */
  readonly getAppInfo: () => AppInfo
  readonly getSettings: () => Promise<Record<string, unknown>>
  readonly getMcpServers: () => Promise<readonly Record<string, unknown>[]>
  readonly getSession: (
    sessionId: string,
  ) => Promise<{ title: string; events: readonly Record<string, unknown>[] } | undefined>
  readonly getMainLogs: () => string | Promise<string>
  readonly getHostLogs: () => string | Promise<string>
  /** 命令沙箱配置与能力探测（M5-05）；不包含项目内容、用户名或凭据。 */
  readonly getSandbox?: () => SandboxStatus | undefined | Promise<SandboxStatus | undefined>
  /** 自动更新状态与备份摘要（M5-06）；不包含更新源凭据。 */
  readonly getUpdate?: () => UpdateDiagnostics | undefined | Promise<UpdateDiagnostics | undefined>
  readonly showSaveDialog?: (defaultName: string) => Promise<string | undefined>
  readonly showItemInFolder?: (filePath: string) => void
  readonly userHomeDir?: string
  /** 已保存的凭据原文（诊断包里逐条替换，双保险）。 */
  readonly getKnownSecrets?: () => readonly string[]
}

/** 统一脱敏函数：消除用户主目录真实路径与凭据。 */
export function sanitizeText(text: string, userHomeDir: string = os.homedir()): string {
  if (!text) return ''
  let sanitized = text

  // 1. 脱敏用户主目录路径（处理反斜杠与正斜杠，忽略大小写）
  if (userHomeDir) {
    const normalizedHome = userHomeDir.replace(/[\\/]+$/, '')
    const backslashHome = normalizedHome.replace(/\//g, '\\')
    const forwardslashHome = normalizedHome.replace(/\\/g, '/')

    const regexBackslash = new RegExp(escapeRegExp(backslashHome), 'gi')
    const regexForwardslash = new RegExp(escapeRegExp(forwardslashHome), 'gi')

    sanitized = sanitized.replace(regexBackslash, '~').replace(regexForwardslash, '~')
  }

  // 2. 脱敏常见 API Key 与 Token
  sanitized = sanitized
    .replace(/\b(sk-[a-zA-Z0-9_-]{16,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(xox[baprs]-[a-zA-Z0-9-]+)\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(["']?apiKey["']?\s*:\s*["'])[^"']+["']/gi, '$1[REDACTED]"')
    .replace(/(["']?token["']?\s*:\s*["'])[^"']+["']/gi, '$1[REDACTED]"')

  return sanitized
}

/** 在 `sanitizeText` 之外，再按已保存的凭据原文逐个替换。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (!secret) continue
    result = result.split(secret).join('[REDACTED_CREDENTIAL]')
  }
  return result
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface DiagnosticProvider {
  readonly id?: string
  readonly displayName?: string
  readonly apiFormat?: string
  readonly baseUrl?: string
  readonly models?: readonly {
    readonly id?: string
    readonly displayName?: string
    readonly contextWindow?: number
  }[]
}

interface DiagnosticSettings {
  readonly providers?: readonly DiagnosticProvider[]
  readonly defaultModel?: unknown
  readonly theme?: string
}

interface DiagnosticMcpServer {
  readonly serverId?: string
  readonly name?: string
  readonly transport?: string
  readonly enabled?: boolean
  readonly toolCount?: number
  readonly tools?: readonly unknown[]
}

interface DiagnosticSessionEvent {
  readonly seq?: number
  readonly ts?: number
  readonly type?: string
  readonly turnId?: string
  readonly runId?: string
  readonly error?: unknown
  readonly usage?: unknown
  readonly model?: unknown
  readonly message?: { readonly role?: string; readonly content?: unknown }
  readonly toolName?: string
  readonly name?: string
  readonly status?: string
}

/** 生成脱敏的设置摘要。 */
export function summarizeSettings(
  settings: DiagnosticSettings | undefined,
  mcpServers: readonly DiagnosticMcpServer[] = [],
): Record<string, unknown> {
  const providers = (settings?.providers ?? []).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    apiFormat: p.apiFormat,
    isOfficialUrl: p.baseUrl === undefined || p.baseUrl === '' || isOfficialUrl(p.baseUrl),
    models: (p.models ?? []).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
    })),
  }))

  const servers = mcpServers.map((s) => ({
    serverId: s.serverId,
    name: s.name,
    transport: s.transport,
    enabled: s.enabled,
    toolCount: s.toolCount ?? s.tools?.length ?? 0,
  }))

  return {
    defaultModel: settings?.defaultModel,
    providers,
    mcpServers: servers,
    theme: settings?.theme ?? 'system',
  }
}

function isOfficialUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname.endsWith('openai.com') ||
      hostname.endsWith('anthropic.com') ||
      hostname.endsWith('deepseek.com') ||
      hostname.endsWith('openrouter.ai') ||
      hostname.endsWith('google.com')
    )
  } catch {
    return false
  }
}

/** 脱敏会话事件：默认过滤掉具体消息内容与工具输入/输出中的详细数据。 */
export function summarizeSessionEvents(
  events: readonly DiagnosticSessionEvent[],
  includeSensitiveContent: boolean,
  userHomeDir: string,
): Record<string, unknown>[] {
  return events.map((ev) => {
    if (includeSensitiveContent) {
      // 先按字段脱敏再序列化：直接对 JSON 文本做替换会漏掉被转义的反斜杠路径。
      return sanitizeValue(ev, userHomeDir) as Record<string, unknown>
    }

    // 默认脱敏摘要：保留事件类型、时间戳、序列号与错误状态
    const clean: Record<string, unknown> = {
      seq: ev.seq,
      ts: ev.ts,
      type: ev.type,
    }

    if (ev.turnId !== undefined) clean.turnId = ev.turnId
    if (ev.runId !== undefined) clean.runId = ev.runId
    if (ev.error !== undefined) clean.error = ev.error
    if (ev.usage !== undefined) clean.usage = ev.usage
    if (ev.model !== undefined) clean.model = ev.model

    if (ev.type === 'message.created') {
      clean.role = ev.message?.role
      clean.contentLength =
        typeof ev.message?.content === 'string' ? ev.message.content.length : undefined
      clean.contentSummary = '[CONTENT_OMITTED_BY_DEFAULT]'
    } else if (ev.type?.startsWith('tool.')) {
      clean.toolName = ev.toolName ?? ev.name
      clean.status = ev.status
    }

    return sanitizeValue(clean, userHomeDir) as Record<string, unknown>
  })
}

/** 递归对对象中的字符串（含键名）应用脱敏，避免序列化转义后漏替换。 */
function sanitizeValue(value: unknown, userHomeDir: string): unknown {
  if (typeof value === 'string') return sanitizeText(value, userHomeDir)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, userHomeDir))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[sanitizeText(key, userHomeDir)] = sanitizeValue(item, userHomeDir)
    }
    return result
  }
  return value
}

export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsDeps) {}

  async summary(input?: DiagnosticsExportInput): Promise<DiagnosticsSummary> {
    const build = this.deps.getAppInfo()
    const appVersion = build.version
    const electronVersion = build.electronVersion
    const settings = await this.deps.getSettings()
    const mcpServers = await this.deps.getMcpServers()
    const mainLogs = await this.deps.getMainLogs()
    const hostLogs = await this.deps.getHostLogs()
    const sandbox = await this.deps.getSandbox?.()
    const update = await this.deps.getUpdate?.()

    let sessionSummary: DiagnosticsSummary['session'] = undefined
    if (input?.sessionId) {
      const session = await this.deps.getSession(input.sessionId)
      if (session) {
        sessionSummary = {
          sessionId: input.sessionId,
          title: session.title,
          eventsCount: session.events.length,
          includeSensitiveContent: input.includeSensitiveSessionContent ?? false,
        }
      }
    }

    const exportItems = [
      'manifest.json',
      'app-version.json',
      'build-info.json',
      'settings-summary.json',
      ...(sandbox ? ['sandbox.json'] : []),
      ...(update ? ['update.json'] : []),
      'logs/main.log',
      'logs/host.log',
    ]
    if (sessionSummary) {
      exportItems.push('session/events.json')
    }

    return {
      appVersion,
      electronVersion,
      build,
      platform: process.platform,
      arch: process.arch,
      logs: {
        mainLogLines: mainLogs ? mainLogs.split('\n').length : 0,
        hostLogLines: hostLogs ? hostLogs.split('\n').length : 0,
      },
      settings: {
        providersCount: ((settings as DiagnosticSettings | undefined)?.providers ?? []).length,
        mcpServersCount: mcpServers.length,
      },
      ...(sandbox ? { sandbox } : {}),
      ...(update ? { update } : {}),
      session: sessionSummary,
      exportItems,
    }
  }

  async createZipBuffer(input?: DiagnosticsExportInput): Promise<Uint8Array> {
    const home = this.deps.userHomeDir ?? os.homedir()
    const secrets = this.deps.getKnownSecrets?.() ?? []
    const clean = (text: string) => redactSecrets(sanitizeText(text, home), secrets)
    const build = this.deps.getAppInfo()
    const appVersion = build.version
    const electronVersion = build.electronVersion
    const settings = await this.deps.getSettings()
    const mcpServers = await this.deps.getMcpServers()
    const mainLogs = await this.deps.getMainLogs()
    const hostLogs = await this.deps.getHostLogs()
    const sandbox = await this.deps.getSandbox?.()
    const update = await this.deps.getUpdate?.()

    const versionInfo = {
      appVersion,
      electronVersion,
      nodeVersion: process.versions.node,
      channel: build.channel,
      commit: build.commit,
      buildTime: build.buildTime,
      databaseSchemaVersion: build.databaseSchemaVersion,
      packaged: build.packaged,
      git: build.git,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      exportedAt: new Date().toISOString(),
    }

    const settingsSummary = summarizeSettings(settings, mcpServers)

    const zipEntries: Record<string, Uint8Array> = {
      'manifest.json': strToU8(
        JSON.stringify(
          {
            schemaVersion: 1,
            generator: 'Cairn Diagnostics',
            createdAt: new Date().toISOString(),
            sessionId: input?.sessionId,
            includeSensitiveSessionContent: input?.includeSensitiveSessionContent ?? false,
          },
          null,
          2,
        ),
      ),
      'app-version.json': strToU8(JSON.stringify(versionInfo, null, 2)),
      'build-info.json': strToU8(clean(JSON.stringify(build, null, 2))),
      'settings-summary.json': strToU8(clean(JSON.stringify(settingsSummary, null, 2))),
      'logs/main.log': strToU8(clean(mainLogs)),
      'logs/host.log': strToU8(clean(hostLogs)),
      ...(sandbox ? { 'sandbox.json': strToU8(clean(JSON.stringify(sandbox, null, 2))) } : {}),
      ...(update ? { 'update.json': strToU8(clean(JSON.stringify(update, null, 2))) } : {}),
    }

    if (input?.sessionId) {
      const session = await this.deps.getSession(input.sessionId)
      if (session) {
        const sessionData = {
          sessionId: input.sessionId,
          title: session.title,
          events: summarizeSessionEvents(
            session.events,
            input.includeSensitiveSessionContent ?? false,
            home,
          ),
        }
        zipEntries['session/events.json'] = strToU8(clean(JSON.stringify(sessionData, null, 2)))
      }
    }

    return zipSync(zipEntries)
  }

  async export(input?: DiagnosticsExportInput): Promise<DiagnosticsExportResult> {
    const defaultName = `cairn-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
    let targetPath: string | undefined

    if (this.deps.showSaveDialog) {
      targetPath = await this.deps.showSaveDialog(defaultName)
      if (!targetPath) {
        return { cancelled: true }
      }
    } else {
      targetPath = path.join(os.tmpdir(), defaultName)
    }

    const zipBuffer = await this.createZipBuffer(input)
    fs.writeFileSync(targetPath, zipBuffer)

    return {
      path: targetPath,
      cancelled: false,
    }
  }

  showInFolder({ path: filePath }: { path: string }): { shown: boolean } {
    if (this.deps.showItemInFolder) {
      this.deps.showItemInFolder(filePath)
      return { shown: true }
    }
    return { shown: false }
  }
}
