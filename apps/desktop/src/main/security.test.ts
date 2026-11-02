import { describe, expect, it, vi } from 'vitest'
import {
  buildContentSecurityPolicy,
  hardenWebContents,
  isAppUrl,
  isExternalUrl,
  isPermissionAllowed,
  restrictPermissions,
  secureWebPreferences,
  type SessionLike,
  type WebContentsLike,
} from './security.js'

describe('secureWebPreferences', () => {
  it('isolates the renderer from Node', () => {
    expect(secureWebPreferences('/app/preload/index.cjs')).toEqual({
      preload: '/app/preload/index.cjs',
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
    })
  })
})

describe('buildContentSecurityPolicy', () => {
  const directives = (csp: string) =>
    Object.fromEntries(
      csp.split('; ').map((d) => {
        const [name, ...values] = d.split(' ')
        return [name, values]
      }),
    )

  it('allows only bundled scripts in production', () => {
    const csp = directives(buildContentSecurityPolicy({ dev: false }))
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['script-src']).toEqual(["'self'"])
    expect(csp['connect-src']).toEqual(["'self'"])
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['frame-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'none'"])
    expect(csp['form-action']).toEqual(["'none'"])
    expect(JSON.stringify(csp)).not.toContain('unsafe-eval')
  })

  it('relaxes scripts and connections for the dev server only', () => {
    const csp = directives(buildContentSecurityPolicy({ dev: true }))
    expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'"])
    expect(csp['connect-src']).toEqual(["'self'", 'ws://localhost:*', 'http://localhost:*'])
    expect(JSON.stringify(csp)).not.toContain('unsafe-eval')
  })
})

const policy = { rendererUrl: 'file:///C:/app/out/renderer/index.html' }
const devPolicy = { ...policy, devServerUrl: 'http://localhost:5173/' }

describe('isAppUrl', () => {
  it('accepts the renderer page with any query or hash', () => {
    expect(isAppUrl('file:///C:/app/out/renderer/index.html', policy)).toBe(true)
    expect(isAppUrl('file:///C:/app/out/renderer/index.html?x=1#/sessions', policy)).toBe(true)
  })

  it('rejects other files, remote pages and malformed URLs', () => {
    expect(isAppUrl('file:///C:/Windows/System32/drivers/etc/hosts', policy)).toBe(false)
    expect(isAppUrl('https://example.com/', policy)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', policy)).toBe(false)
    expect(isAppUrl('not a url', policy)).toBe(false)
    expect(isAppUrl('file:///x', { rendererUrl: 'nope' })).toBe(false)
  })

  it('accepts the dev server origin in development', () => {
    expect(isAppUrl('http://localhost:5173/index.html', devPolicy)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', devPolicy)).toBe(false)
    expect(isAppUrl('https://evil.example/', devPolicy)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', { ...policy, devServerUrl: '::bad' })).toBe(false)
  })
})

describe('isExternalUrl', () => {
  it('allows http and https only', () => {
    expect(isExternalUrl('https://github.com/')).toBe(true)
    expect(isExternalUrl('http://example.com/')).toBe(true)
    expect(isExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalUrl('ms-settings:privacy')).toBe(false)
    expect(isExternalUrl('nonsense')).toBe(false)
  })
})

function fakeContents() {
  const listeners = new Map<string, (event: never) => void>()
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
  const contents = {
    on: (name: string, listener: (event: never) => void) => listeners.set(name, listener),
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler
    },
  } as unknown as WebContentsLike
  const fire = (name: string, url = '') => {
    const event = { url, preventDefault: vi.fn() }
    listeners.get(name)?.(event as never)
    return event.preventDefault.mock.calls.length > 0
  }
  return { contents, fire, open: (url: string) => openHandler?.({ url }) }
}

describe('hardenWebContents', () => {
  it('blocks navigation and redirects away from the app', () => {
    const { contents, fire } = fakeContents()
    const onBlocked = vi.fn()
    hardenWebContents(contents, { policy, openExternal: vi.fn(), onBlocked })

    expect(fire('will-navigate', 'file:///C:/app/out/renderer/index.html#/x')).toBe(false)
    expect(fire('will-navigate', 'https://evil.example/')).toBe(true)
    expect(fire('will-redirect', 'file:///C:/secret.txt')).toBe(true)
    expect(fire('will-attach-webview')).toBe(true)
    expect(onBlocked.mock.calls).toEqual([
      ['navigate', 'https://evil.example/'],
      ['redirect', 'file:///C:/secret.txt'],
      ['webview', ''],
    ])
  })

  it('denies new windows and opens web links in the system browser', () => {
    const { contents, open } = fakeContents()
    const openExternal = vi.fn()
    const onBlocked = vi.fn()
    hardenWebContents(contents, { policy, openExternal, onBlocked })

    expect(open('https://github.com/960602906')).toEqual({ action: 'deny' })
    expect(open('file:///C:/Windows/notepad.exe')).toEqual({ action: 'deny' })
    expect(openExternal.mock.calls).toEqual([['https://github.com/960602906']])
    expect(onBlocked).toHaveBeenCalledWith('window', 'file:///C:/Windows/notepad.exe')
  })

  it('works without a blocked-callback', () => {
    const { contents, fire, open } = fakeContents()
    hardenWebContents(contents, { policy, openExternal: vi.fn() })
    expect(fire('will-navigate', 'https://evil.example/')).toBe(true)
    expect(fire('will-attach-webview')).toBe(true)
    expect(open('about:blank')).toEqual({ action: 'deny' })
  })
})

describe('permissions', () => {
  it('denies everything except clipboard writes', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read']) {
      expect(isPermissionAllowed(p)).toBe(false)
    }

    let request: Parameters<SessionLike['setPermissionRequestHandler']>[0] | undefined
    let check: Parameters<SessionLike['setPermissionCheckHandler']>[0] | undefined
    restrictPermissions({
      setPermissionRequestHandler: (h) => (request = h),
      setPermissionCheckHandler: (h) => (check = h),
    })
    const callback = vi.fn()
    request?.(null, 'media', callback)
    request?.(null, 'clipboard-sanitized-write', callback)
    expect(callback.mock.calls).toEqual([[false], [true]])
    expect(check?.(null, 'geolocation')).toBe(false)
  })
})
