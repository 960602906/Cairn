/**
 * 资源市场目录（M5）：从 ClawHub 拉技能卡片，从官方 MCP Registry 拉可接入的服务。
 * 只做只读目录与网络抓取；技能安装仍由 `skill-service` 写盘，MCP 安装仍走 `mcp.add`。
 */
import type { HubMcpCard, HubSkillCard } from '@cairn/protocol'

const CLAWHUB_BASE = 'https://clawhub.ai'
const MCP_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1'
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 48
const FETCH_TIMEOUT_MS = 15_000

export interface HubCommands {
  skills(input: { query?: string | undefined; limit?: number | undefined }): Promise<{
    items: HubSkillCard[]
  }>
  mcp(input: { query?: string | undefined; limit?: number | undefined }): Promise<{
    items: HubMcpCard[]
  }>
}

type RawRecord = Record<string, unknown>

const asRecord = (value: unknown): RawRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RawRecord) : {}
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function safeUrl(value: unknown): string | undefined {
  const raw = asString(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function limitOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
}

async function getJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Hub request failed with HTTP ${response.status}`)
  }
  return response.json()
}

function normalizeSkill(raw: unknown): HubSkillCard | undefined {
  const item = asRecord(raw)
  const slug = asString(item.slug)
  if (!slug) return undefined
  const stats = asRecord(item.stats)
  const owner = asRecord(item.owner)
  const ownerHandle = asString(item.ownerHandle) ?? asString(owner.handle)
  const latest = asRecord(item.latestVersion)
  const downloadUrl =
    safeUrl(item.downloadUrl) ??
    (() => {
      const url = new URL('/api/v1/download', CLAWHUB_BASE)
      url.searchParams.set('slug', slug)
      url.searchParams.set('tag', 'latest')
      if (ownerHandle) url.searchParams.set('ownerHandle', ownerHandle)
      return url.toString()
    })()
  const webUrl =
    safeUrl(item.webUrl) ??
    (() => {
      const canonical = asString(item.canonicalUrl) ?? asString(asRecord(item.links).canonical)
      if (canonical) {
        try {
          const url = new URL(canonical, CLAWHUB_BASE)
          if (url.protocol === 'https:') return url.toString()
        } catch {
          // 落到下面按 owner + slug 拼详情页
        }
      }
      return ownerHandle
        ? `${CLAWHUB_BASE}/${encodeURIComponent(ownerHandle)}/skills/${encodeURIComponent(slug)}`
        : undefined
    })()
  return {
    slug,
    displayName: asString(item.displayName) ?? slug,
    summary: asString(item.summary) ?? '',
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(() => {
      const version =
        asString(item.latestVersion) ?? asString(latest.version) ?? asString(item.version)
      return version ? { version } : {}
    })(),
    downloads: asNumber(item.downloads) ?? asNumber(stats.downloads) ?? 0,
    stars: asNumber(item.stars) ?? asNumber(stats.stars) ?? 0,
    ...(() => {
      const updated = asNumber(item.updatedAt) ?? asNumber(latest.createdAt)
      return updated ? { updatedAt: updated } : {}
    })(),
    ...(webUrl ? { webUrl } : {}),
    downloadUrl,
  }
}

function normalizeMcp(raw: unknown): HubMcpCard | undefined {
  const item = asRecord(raw)
  const server = asRecord(item.server ?? raw)
  const name = asString(server.name)
  if (!name) return undefined
  const remotes = asArray(server.remotes).map(asRecord)
  const remote = remotes.find((entry) => {
    const type = asString(entry.type)
    return type === 'streamable-http' || type === 'http'
  })
  const packages = asArray(server.packages)
  const transport = remote ? 'http' : packages.length > 0 ? 'stdio' : undefined
  if (!transport) return undefined
  const url = remote ? safeUrl(remote.url) : undefined
  if (transport === 'http' && !url) return undefined
  const segment = name.split('/').pop() ?? name
  const fallbackTitle =
    segment.length >= 4 && !['mcp', 'server', 'sse'].includes(segment.toLowerCase())
      ? segment
      : name
  return {
    id: name,
    name,
    title: asString(server.title) ?? fallbackTitle,
    description: asString(server.description) ?? '',
    ...(() => {
      const version = asString(server.version)
      return version ? { version } : {}
    })(),
    transport,
    ...(url ? { url } : {}),
    ...(() => {
      const homepage = safeUrl(server.homepage)
      return homepage ? { homepage } : {}
    })(),
    ...(() => {
      const repository = safeUrl(asRecord(server.repository).url)
      return repository ? { repository } : {}
    })(),
    requiresAuth: asArray(remote?.headers).some((entry) => asRecord(entry).isRequired === true),
  }
}

export function createHubService(): HubCommands {
  return {
    async skills({ query, limit }) {
      const url = new URL(query?.trim() ? '/api/v1/search' : '/api/v1/skills', CLAWHUB_BASE)
      url.searchParams.set('limit', String(limitOf(limit)))
      if (query?.trim()) url.searchParams.set('q', query.trim())
      else {
        url.searchParams.set('sort', 'downloads')
        url.searchParams.set('nonSuspiciousOnly', 'true')
      }
      const json = asRecord(await getJson(url))
      const raw = asArray(json.items ?? json.results)
      const seen = new Set<string>()
      const items: HubSkillCard[] = []
      for (const entry of raw) {
        const card = normalizeSkill(entry)
        if (!card || seen.has(card.slug)) continue
        seen.add(card.slug)
        items.push(card)
      }
      return { items }
    },

    async mcp({ query, limit }) {
      const url = new URL('servers', `${MCP_REGISTRY_BASE}/`)
      url.searchParams.set('limit', String(limitOf(limit)))
      url.searchParams.set('version', 'latest')
      if (query?.trim()) url.searchParams.set('search', query.trim())
      const json = asRecord(await getJson(url))
      const seen = new Set<string>()
      const items: HubMcpCard[] = []
      for (const entry of asArray(json.servers)) {
        const card = normalizeMcp(entry)
        if (!card || seen.has(card.id)) continue
        seen.add(card.id)
        items.push(card)
      }
      return { items }
    },
  }
}
