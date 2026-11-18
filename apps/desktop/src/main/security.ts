/**
 * 窗口安全基线（架构 §17，M0-12b）。
 *
 * - 窗口选项：`contextIsolation`、`sandbox`、禁用 Node 集成与 `<webview>`。
 * - CSP：构建时以 `<meta>` 写入界面的 HTML（`electron.vite.config.ts`），开发模式放宽到能使用 HMR。
 * - 导航：只允许留在应用自己的页面；新窗口一律拒绝，`http(s)` 链接交给系统浏览器打开。
 * - 权限：除写剪贴板外一律拒绝（摄像头、麦克风、通知、地理位置等）。
 *
 * 这里只有纯函数与对结构化接口的操作，便于单元测试；Electron 对象由主进程入口传入。
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SecureWebPreferences {
  readonly preload: string
  readonly contextIsolation: true
  readonly sandbox: true
  readonly nodeIntegration: false
  readonly nodeIntegrationInWorker: false
  readonly nodeIntegrationInSubFrames: false
  readonly webSecurity: true
  readonly allowRunningInsecureContent: false
  readonly webviewTag: false
  readonly navigateOnDragDrop: false
  readonly safeDialogs: true
}

export function secureWebPreferences(preload: string): SecureWebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
  }
}

/**
 * 界面的 CSP。生产环境只允许加载应用自己的脚本；开发模式额外允许 Vite 注入的内联脚本
 * （React Fast Refresh）与本机的 HMR 连接。`frame-ancestors` 在 `<meta>` 中无效，不写入。
 */
export function buildContentSecurityPolicy({ dev }: { readonly dev: boolean }): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // React 的 style 属性与后续组件库需要内联样式
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': dev ? ["'self'", 'ws://localhost:*', 'http://localhost:*'] : ["'self'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}

export interface NavigationPolicy {
  /** 生产环境界面入口的 `file:` URL。 */
  readonly rendererUrl: string
  /** 开发模式的 Vite 开发服务器地址。 */
  readonly devServerUrl?: string | undefined
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/**
 * 把 `file:` URL 变成可比较的本地路径。
 *
 * Windows 上同一份文件可能以长路径或 8.3 短路径（`C:\Users\RUNNER~1\...`）出现：Chromium
 * 报告的页面 URL 与主进程用 `import.meta.dirname` 拼出的入口各用其一，直接比较 pathname 会
 * 把同一页面判成两个。这里解析符号链接与短名，并在 win32 上忽略大小写。
 *
 * 页面位于 `app.asar` 内时整条路径可能无法 `realpath`，因此逐级向上找到磁盘上真实存在的
 * 祖先目录再拼回剩余部分；祖先目录都解析不了时退回绝对路径。
 */
function canonicalFilePath(url: URL): string | undefined {
  let file: string
  try {
    file = fileURLToPath(url)
  } catch {
    return undefined
  }
  const rest: string[] = []
  let current = path.resolve(file)
  for (;;) {
    try {
      current = realpathSync.native(current)
      break
    } catch {
      const parent = path.dirname(current)
      if (parent === current) break
      rest.unshift(path.basename(current))
      current = parent
    }
  }
  const resolved = rest.length === 0 ? current : path.join(current, ...rest)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 是否是应用自己的页面（忽略查询参数与 hash）。 */
export function isAppUrl(url: string, policy: NavigationPolicy): boolean {
  const target = parse(url)
  if (!target) return false
  if (policy.devServerUrl !== undefined) {
    const dev = parse(policy.devServerUrl)
    if (dev && target.origin === dev.origin && target.protocol.startsWith('http')) return true
  }
  const renderer = parse(policy.rendererUrl)
  if (renderer === undefined || target.protocol !== 'file:' || renderer.protocol !== 'file:') {
    return false
  }
  const targetPath = canonicalFilePath(target)
  const rendererPath = canonicalFilePath(renderer)
  // 不带盘符或含编码斜杠的 file URL 无法转成本地路径；此时退回逐字比较，与旧行为一致。
  if (targetPath === undefined || rendererPath === undefined) {
    return target.host === renderer.host && target.pathname === renderer.pathname
  }
  return targetPath === rendererPath
}

/** 可以交给系统浏览器打开的地址。 */
export function isExternalUrl(url: string): boolean {
  const target = parse(url)
  return target !== undefined && (target.protocol === 'https:' || target.protocol === 'http:')
}

/** `hardenWebContents` 用到的 `WebContents` 接口。 */
export interface WebContentsLike {
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (event: { preventDefault(): void; readonly url: string }) => void,
  ): unknown
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: 'deny' }): void
}

export interface HardenOptions {
  readonly policy: NavigationPolicy
  /** 用系统浏览器打开外部链接。 */
  readonly openExternal: (url: string) => void
  /** 记录被拦截的操作。 */
  readonly onBlocked?: (kind: 'navigate' | 'redirect' | 'window' | 'webview', url: string) => void
}

/** 拦截导航、新窗口与 `<webview>`。对应用创建的每个 `WebContents` 调用。 */
export function hardenWebContents(contents: WebContentsLike, options: HardenOptions): void {
  const { policy, openExternal, onBlocked } = options
  const guard =
    (kind: 'navigate' | 'redirect') =>
    (event: { preventDefault(): void; readonly url: string }) => {
      if (isAppUrl(event.url, policy)) return
      event.preventDefault()
      onBlocked?.(kind, event.url)
    }
  contents.on('will-navigate', guard('navigate'))
  contents.on('will-redirect', guard('redirect'))
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    onBlocked?.('webview', '')
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) openExternal(url)
    else onBlocked?.('window', url)
    return { action: 'deny' }
  })
}

/** 允许的权限。写剪贴板用于"复制"按钮。 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

/** `restrictPermissions` 用到的 `Session` 接口。 */
export interface SessionLike {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void
  setPermissionCheckHandler(
    handler: (contents: unknown, permission: string, ...rest: unknown[]) => boolean,
  ): void
}

export function restrictPermissions(session: SessionLike): void {
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(isPermissionAllowed(permission)),
  )
  session.setPermissionCheckHandler((_contents, permission) => isPermissionAllowed(permission))
}
