import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHubService } from './hub-service.js'

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('hub service', () => {
  it('normalizes and dedupes ClawHub skills', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          items: [
            {
              slug: 'pdf',
              displayName: 'PDF',
              summary: 'Read PDFs.',
              owner: { handle: 'acme' },
              stats: { downloads: 12, stars: 3 },
              latestVersion: { version: '1.2.0' },
            },
            { slug: 'pdf', displayName: 'Duplicate' },
            { slug: 'git', displayName: 'Git' },
          ],
        }),
      ),
    )
    const hub = createHubService()
    const result = await hub.skills({ limit: 10 })
    expect(result.items.map((item) => item.slug)).toEqual(['pdf', 'git'])
    expect(result.items[0]).toMatchObject({
      displayName: 'PDF',
      ownerHandle: 'acme',
      version: '1.2.0',
      downloads: 12,
      stars: 3,
    })
    expect(result.items[0]?.downloadUrl).toBe(
      'https://clawhub.ai/api/v1/download?slug=pdf&tag=latest&ownerHandle=acme',
    )
    expect(result.items[0]?.webUrl).toBe('https://clawhub.ai/acme/skills/pdf')
  })

  it('reads the ClawHub search response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          results: [
            {
              slug: 'github',
              displayName: 'Github',
              summary: 'Interact with GitHub.',
              ownerHandle: 'steipete',
              canonicalUrl: '/steipete/skills/github',
              downloads: 204420,
              metrics: { updatedAt: 1781268517834 },
            },
          ],
        }),
      ),
    )
    const hub = createHubService()
    const result = await hub.skills({ query: 'github' })
    expect(result.items[0]).toMatchObject({
      slug: 'github',
      displayName: 'Github',
      ownerHandle: 'steipete',
      downloads: 204420,
      webUrl: 'https://clawhub.ai/steipete/skills/github',
      downloadUrl: 'https://clawhub.ai/api/v1/download?slug=github&tag=latest&ownerHandle=steipete',
    })
  })

  it('falls back through alternate ClawHub fields and drops invalid links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          items: [
            {
              slug: 'alpha',
              displayName: '',
              summary: '',
              ownerHandle: 'acme',
              downloadUrl: 'http://cdn.example.com/alpha.zip',
              webUrl: 'http://insecure.example.com/alpha',
              canonicalUrl: 'http://[::1',
              latestVersion: '2.1.0',
              stats: { downloads: 8, stars: 2 },
              updatedAt: 0,
            },
            {
              slug: 'beta',
              owner: { handle: 'bob' },
              canonicalUrl: 'https://clawhub.ai/bob/skills/beta',
              latestVersion: { version: '1.0.0', createdAt: 0 },
              stats: { downloads: 5, stars: 1 },
            },
            {
              slug: 'gamma',
              ownerHandle: 'carol',
              links: { canonical: '/carol/skills/gamma' },
              latestVersion: {},
              version: '3.0.0',
              downloads: 2,
              updatedAt: 42,
            },
            {
              slug: 'delta',
              downloadUrl: 'https://cdn.example.com/delta.zip',
              webUrl: 'https://example.com/delta',
              latestVersion: { version: '4.0.0', createdAt: 99 },
              downloads: 0,
              stars: 0,
            },
            { slug: 'epsilon', canonicalUrl: 'ftp://example.com/epsilon' },
            { displayName: 'Missing slug' },
            { slug: 'alpha', displayName: 'Duplicate' },
          ],
        }),
      ),
    )
    const hub = createHubService()
    const result = await hub.skills({})
    expect(result.items.map((item) => item.slug)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
    ])
    expect(result.items[0]).toMatchObject({
      displayName: 'alpha',
      summary: '',
      ownerHandle: 'acme',
      version: '2.1.0',
      downloads: 8,
      stars: 2,
      webUrl: 'https://clawhub.ai/acme/skills/alpha',
      downloadUrl: 'https://clawhub.ai/api/v1/download?slug=alpha&tag=latest&ownerHandle=acme',
    })
    expect(result.items[0]?.updatedAt).toBeUndefined()
    expect(result.items[1]).toMatchObject({
      ownerHandle: 'bob',
      version: '1.0.0',
      webUrl: 'https://clawhub.ai/bob/skills/beta',
    })
    expect(result.items[1]?.updatedAt).toBeUndefined()
    expect(result.items[2]).toMatchObject({
      version: '3.0.0',
      downloads: 2,
      stars: 0,
      updatedAt: 42,
      webUrl: 'https://clawhub.ai/carol/skills/gamma',
    })
    expect(result.items[3]).toMatchObject({
      webUrl: 'https://example.com/delta',
      downloadUrl: 'https://cdn.example.com/delta.zip',
      updatedAt: 99,
    })
    expect(result.items[4]).toMatchObject({
      displayName: 'epsilon',
      summary: '',
      downloads: 0,
      stars: 0,
    })
    expect(result.items[4]?.webUrl).toBeUndefined()
  })

  it('normalizes limit and query parameters', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      json({ items: [], results: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const hub = createHubService()

    await hub.skills({})
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://clawhub.ai/api/v1/skills?limit=24&sort=downloads&nonSuspiciousOnly=true',
    )

    await hub.skills({ limit: 0 })
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('limit=1')

    await hub.skills({ limit: -5 })
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('limit=1')

    await hub.skills({ limit: 999 })
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('limit=48')

    await hub.skills({ limit: 12.9 })
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain('limit=12')

    await hub.skills({ query: '  pdf  ', limit: 2 })
    expect(String(fetchMock.mock.calls[5]?.[0])).toBe(
      'https://clawhub.ai/api/v1/search?limit=2&q=pdf',
    )
  })

  it('keeps remote MCP entries and flags auth, plus stdio-only packages', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      json({
        servers: [
          {
            server: {
              name: 'acme/remote',
              title: 'Remote',
              description: 'Remote server.',
              version: '1.0.0',
              remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
            },
          },
          {
            server: {
              name: 'acme/auth',
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://auth.example.com/mcp',
                  headers: [{ name: 'Authorization', isRequired: true }],
                },
              ],
            },
          },
          {
            server: {
              name: 'acme/local',
              packages: [{ registryType: 'npm', identifier: '@acme/mcp' }],
            },
          },
          { server: { name: 'acme/none' } },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const hub = createHubService()
    const result = await hub.mcp({ query: 'acme' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('version=latest')
    expect(result.items.map((item) => [item.name, item.transport])).toEqual([
      ['acme/remote', 'http'],
      ['acme/auth', 'http'],
      ['acme/local', 'stdio'],
    ])
    expect(result.items[1]?.requiresAuth).toBe(true)
    expect(result.items[0]?.requiresAuth).toBe(false)
  })

  it('handles alternate MCP entries, invalid URLs and title fallbacks', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      json({
        servers: [
          {
            server: {
              name: 'acme/remote',
              title: 'Remote',
              description: 'Remote server.',
              version: '1.0.0',
              remotes: [
                { type: 'sse', url: 'https://ignored.example.com/sse' },
                { type: 'http', url: 'https://mcp.example.com/mcp', headers: [null] },
              ],
              homepage: 'http://insecure.example.com',
              repository: { url: 'https://github.com/acme/remote' },
            },
          },
          {
            name: 'acme/fetch',
            packages: [{ registryType: 'npm', identifier: '@acme/fetch' }],
          },
          {
            server: {
              name: 'acme/mcp',
              packages: [{ registryType: 'npm', identifier: '@acme/mcp' }],
              homepage: 'https://acme.example.com',
              repository: {},
            },
          },
          {
            server: {
              name: 'acme/sse',
              remotes: [{ type: 'streamable-http', url: 'https://sse.example.com/mcp' }],
              headers: [],
            },
          },
          {
            server: {
              name: 'acme/badurl',
              remotes: [{ type: 'http', url: 'ftp://example.com/mcp' }],
            },
          },
          { server: { name: 'acme/none' } },
          { server: {} },
          { server: { name: 'acme/remote' } },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const hub = createHubService()
    const result = await hub.mcp({})

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers?limit=24&version=latest',
    )
    expect(result.items).toHaveLength(4)
    expect(result.items[0]).toMatchObject({
      id: 'acme/remote',
      title: 'Remote',
      description: 'Remote server.',
      version: '1.0.0',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      repository: 'https://github.com/acme/remote',
      requiresAuth: false,
    })
    expect(result.items[0]?.homepage).toBeUndefined()
    expect(result.items[1]).toMatchObject({
      id: 'acme/fetch',
      title: 'fetch',
      description: '',
      transport: 'stdio',
    })
    expect(result.items[2]).toMatchObject({
      id: 'acme/mcp',
      title: 'acme/mcp',
      homepage: 'https://acme.example.com/',
      transport: 'stdio',
    })
    expect(result.items[2]?.repository).toBeUndefined()
    expect(result.items[3]).toMatchObject({
      id: 'acme/sse',
      title: 'acme/sse',
      transport: 'http',
      requiresAuth: false,
    })
  })

  it('passes MCP search params and reports registry errors', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json({ servers: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const hub = createHubService()
    await hub.mcp({ query: 'github', limit: 999 })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers?limit=48&version=latest&search=github',
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    )
    await expect(hub.mcp({})).rejects.toThrow('HTTP 503')
  })
})
