/**
 * 供应商图标（ADR-0049）：界面的 CSP 只允许 `data:` 图片，图标由主进程下载后以 `data:` 地址返回。
 *
 * - 有显式的 `icon`：内联图片原样返回；https 图片下载后返回，失败时退回网站图标。
 * - 没有 `icon`：像浏览器一样找网站图标——依次打开 `homepage`、`keysUrl`、`baseUrl` 所在站点的首页
 *   （`api.` 之类的子域名再试上一级域名），读 `<link rel="icon">` / `apple-touch-icon`，都没有时用
 *   `/favicon.ico`。找到第一个能用的就停。
 * - 只访问公网的 https 地址（本机服务没有网站图标，界面显示首字母）；图片按内容识别格式，不信任
 *   `Content-Type`，只接受 PNG、JPEG、GIF、WebP、ICO 与 SVG（SVG 以 `<img>` 显示，不会执行脚本）。
 * - 结果（包括找不到）缓存在应用数据目录：找到的保留 14 天，找不到的 1 天后再试。同一来源的并发请求
 *   合并，同时最多下载 4 个来源，打开对话框时不会一下子发出很多请求。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { ICON_DATA_URL_PATTERN, type IconSource } from '@cairn/protocol'
import { isPublicHost, safeFetch } from './safe-fetch.js'

export const ICON_MAX_BYTES = 96 * 1024
/** 网页只读开头这么多字节（足够覆盖 `<head>`）。 */
const PAGE_MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 6_000
const BUDGET_MS = 20_000
const FOUND_TTL_MS = 14 * 24 * 60 * 60 * 1000
const MISSING_TTL_MS = 24 * 60 * 60 * 1000
/** 每个页面最多尝试的图标地址数。 */
const CANDIDATES_PER_PAGE = 4

export interface IconServiceOptions {
  /** 缓存目录；不存在时自动创建。 */
  readonly cacheDir: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly concurrency?: number
}

export interface IconService {
  resolve(source: IconSource): Promise<{ dataUrl?: string }>
}

/** 按内容识别图片格式；不是支持的图片时为 undefined。 */
export function sniffImage(body: Buffer): string | undefined {
  if (body.length < 4) return undefined
  if (body[0] === 0x89 && body.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png'
  if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg'
  if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    body.subarray(0, 4).toString('latin1') === 'RIFF' &&
    body.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return 'image/x-icon'
  const head = body
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (
    /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)
  ) {
    return 'image/svg+xml'
  }
  return undefined
}

const decodeEntities = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

/** 页面中声明的图标，按适合显示的程度排序（SVG、apple-touch-icon 与大尺寸的在前）。 */
export function iconLinksOf(html: string, pageUrl: string): string[] {
  const found: { url: string; score: number; order: number }[] = []
  let order = 0
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {}
    for (const match of tag[0].matchAll(
      /([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    )) {
      attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
    }
    const rel = (attrs['rel'] ?? '').toLowerCase().split(/\s+/)
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')
    if (!touch && !rel.includes('icon')) continue
    const href = decodeEntities(attrs['href']?.trim() ?? '')
    if (href === '') continue
    let url: URL
    try {
      url = new URL(href, pageUrl)
    } catch {
      continue
    }
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'data:' && ICON_DATA_URL_PATTERN.test(href))
    ) {
      continue
    }
    const svg = (attrs['type'] ?? '').includes('svg') || /\.svg(?:$|[?#])/i.test(url.pathname)
    const size = Math.max(
      0,
      ...(attrs['sizes'] ?? '').split(/\s+/).map((s) => Number(/^(\d+)x\d+$/i.exec(s)?.[1] ?? 0)),
    )
    const score = svg
      ? 90
      : touch
        ? 80
        : size >= 32
          ? 70 + Math.min(size, 192) / 10
          : size > 0
            ? 40
            : 50
    found.push({ url: url.protocol === 'data:' ? href : url.toString(), score, order: order++ })
  }
  return found.sort((a, b) => b.score - a.score || a.order - b.order).map((item) => item.url)
}

const originOf = (url: string) => {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}/`
}

/** 找网站图标时依次打开的页面。 */
export function pagesOf(source: IconSource): string[] {
  const pages: string[] = []
  const add = (url: string | undefined) => {
    if (url === undefined) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' || !isPublicHost(parsed.hostname)) return
    if (!pages.includes(parsed.toString())) pages.push(parsed.toString())
  }
  add(source.homepage)
  add(source.keysUrl)
  if (source.baseUrl !== undefined) {
    try {
      const base = new URL(source.baseUrl)
      add(`https://${base.host}/`)
      const labels = base.hostname.split('.')
      if (labels.length >= 3 && isIP(base.hostname) === 0) {
        add(`https://${labels.slice(1).join('.')}/`)
      }
    } catch {
      // 地址已经过协议层校验；解析失败时只是少一个候选
    }
  }
  return pages
}

interface CacheEntry {
  readonly at: number
  readonly dataUrl?: string
}

export function createIconService(options: IconServiceOptions): IconService {
  const now = options.now ?? Date.now
  const memory = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<{ dataUrl?: string }>>()
  const limit = options.concurrency ?? 4
  let running = 0
  const waiting: (() => void)[] = []

  const acquire = async () => {
    if (running < limit) {
      running++
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
    running++
  }
  const release = () => {
    running--
    waiting.shift()?.()
  }

  const fileOf = (key: string) => path.join(options.cacheDir, `${key}.json`)
  const fresh = (entry: CacheEntry) =>
    now() - entry.at < (entry.dataUrl ? FOUND_TTL_MS : MISSING_TTL_MS)

  const readCache = (key: string): CacheEntry | undefined => {
    const cached = memory.get(key)
    if (cached) return fresh(cached) ? cached : undefined
    try {
      const parsed = JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as CacheEntry
      if (typeof parsed.at !== 'number') return undefined
      if (parsed.dataUrl !== undefined && !ICON_DATA_URL_PATTERN.test(parsed.dataUrl))
        return undefined
      memory.set(key, parsed)
      return fresh(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  const writeCache = (key: string, entry: CacheEntry) => {
    memory.set(key, entry)
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true })
      fs.writeFileSync(fileOf(key), JSON.stringify(entry))
    } catch {
      // 缓存只是加速，写不进去也不影响显示
    }
  }

  const fetchImage = async (url: string): Promise<string | undefined> => {
    if (url.startsWith('data:')) return ICON_DATA_URL_PATTERN.test(url) ? url : undefined
    try {
      const response = await safeFetch(url, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        // 只声明能识别的格式：图片 CDN 会按 Accept 协商，声明 AVIF 就可能拿到无法识别的图片
        accept: 'image/webp,image/png,image/svg+xml,image/x-icon,image/*;q=0.8,*/*;q=0.5',
        maxBytes: ICON_MAX_BYTES,
        timeoutMs: TIMEOUT_MS,
      })
      const mime = sniffImage(response.body)
      return mime ? `data:${mime};base64,${response.body.toString('base64')}` : undefined
    } catch {
      return undefined
    }
  }

  const faviconOf = async (
    page: string,
    tried: Set<string>,
    deadline: number,
  ): Promise<string | undefined> => {
    let candidates: string[] = []
    let origin = originOf(page)
    try {
      const response = await safeFetch(page, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        maxBytes: PAGE_MAX_BYTES,
        timeoutMs: TIMEOUT_MS,
        // 图标声明在 <head> 里，大页面只读开头
        truncate: true,
      })
      origin = originOf(response.url)
      if (!sniffImage(response.body)) {
        candidates = iconLinksOf(response.body.toString('utf8'), response.url)
      }
    } catch {
      // 页面打不开时仍然试一下站点根目录的 favicon.ico
    }
    candidates = [...candidates.slice(0, CANDIDATES_PER_PAGE), `${origin}favicon.ico`]
    for (const candidate of candidates) {
      if (tried.has(candidate) || now() > deadline) continue
      tried.add(candidate)
      const image = await fetchImage(candidate)
      if (image) return image
    }
    return undefined
  }

  const compute = async (source: IconSource): Promise<string | undefined> => {
    const deadline = now() + BUDGET_MS
    if (source.icon !== undefined) {
      const explicit = await fetchImage(source.icon)
      if (explicit) return explicit
    }
    const tried = new Set<string>()
    for (const page of pagesOf(source)) {
      if (now() > deadline) break
      const found = await faviconOf(page, tried, deadline)
      if (found) return found
    }
    return undefined
  }

  return {
    async resolve(source) {
      if (source.icon !== undefined && ICON_DATA_URL_PATTERN.test(source.icon)) {
        return { dataUrl: source.icon }
      }
      const key = createHash('sha256')
        .update(
          JSON.stringify([source.icon, source.homepage, source.keysUrl, source.baseUrl] as const),
        )
        .digest('hex')
      const cached = readCache(key)
      if (cached) return cached.dataUrl ? { dataUrl: cached.dataUrl } : {}
      const pending = inflight.get(key)
      if (pending) return pending
      const task = (async () => {
        await acquire()
        try {
          const dataUrl = await compute(source)
          writeCache(key, { at: now(), ...(dataUrl ? { dataUrl } : {}) })
          return dataUrl ? { dataUrl } : {}
        } finally {
          release()
          inflight.delete(key)
        }
      })()
      inflight.set(key, task)
      return task
    },
  }
}
