/**
 * 受限的网络读取（ADR-0049）：供应商图标与官方插件目录共用。
 *
 * - 只访问 https；`publicOnly` 时拒绝本机、局域网与链路本地地址（按主机名与 IP 字面量判断），
 *   跳转逐跳检查，公网地址不能把请求跳到内网。
 * - 有超时与大小上限，超过上限立即中止读取。
 * - 不带 Cookie 或凭据（主进程的 `fetch` 本来就没有）。
 */
import { isIP } from 'node:net'

export type FetchFailure = 'blocked' | 'status' | 'too_large' | 'network'

export class SafeFetchError extends Error {
  constructor(
    readonly reason: FetchFailure,
    readonly status?: number,
  ) {
    super(`fetch failed: ${reason}${status === undefined ? '' : ` (${status})`}`)
    this.name = 'SafeFetchError'
  }
}

export interface LimitedResponse {
  /** 跳转之后的地址。 */
  readonly url: string
  readonly contentType: string
  readonly body: Buffer
}

export interface SafeFetchOptions {
  readonly fetch?: typeof fetch
  readonly accept: string
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly maxRedirects?: number
  /** 只允许公网地址；测试或开发时指向本机服务可以关掉。 */
  readonly publicOnly?: boolean
  /** 允许 http（只用于测试或开发时的目录地址）。 */
  readonly allowHttp?: boolean
}

function privateIpv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function privateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return privateIpv4(mapped[1]!)
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

/** 主机名是否在公网上（不是本机、局域网或链路本地地址）。 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '' || host === 'localhost' || (!host.includes('.') && isIP(host) === 0)) return false
  if (/\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host)) return false
  const family = isIP(host)
  if (family === 4) return !privateIpv4(host)
  if (family === 6) return !privateIpv6(host)
  return true
}

function allowed(url: URL, options: SafeFetchOptions): boolean {
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) return false
  if (url.username || url.password) return false
  return options.publicOnly === false || isPublicHost(url.hostname)
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new SafeFetchError('too_large')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new SafeFetchError('too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** 读取一个地址；失败时抛出 `SafeFetchError`。 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<LimitedResponse> {
  const doFetch = options.fetch ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs)
  let current: URL
  try {
    current = new URL(url)
  } catch {
    throw new SafeFetchError('blocked')
  }
  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    if (!allowed(current, options)) throw new SafeFetchError('blocked')
    let response: Response
    try {
      response = await doFetch(current, {
        headers: { accept: options.accept },
        redirect: 'manual',
        signal,
      })
    } catch {
      throw new SafeFetchError('network')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new SafeFetchError('status', response.status)
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new SafeFetchError('status', response.status)
    let body: Buffer
    try {
      body = await readLimited(response, options.maxBytes)
    } catch (error) {
      if (error instanceof SafeFetchError) throw error
      throw new SafeFetchError('network')
    }
    return {
      url: current.toString(),
      contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
      body,
    }
  }
  throw new SafeFetchError('blocked')
}
