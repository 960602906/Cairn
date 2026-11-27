import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@cairn/protocol'
import {
  createProviderCatalogService,
  OFFICIAL_PROVIDER_CATALOG,
} from './provider-catalog-service.js'
import { createProviderPluginService } from './provider-plugin-service.js'

const FILES = OFFICIAL_PROVIDER_CATALOG.files

const plugin = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'acme',
  name: 'Acme Cloud',
  version: '1.1.0',
  icon: 'icons/acme.svg',
  providers: [
    {
      id: 'gateway',
      name: 'Acme Gateway',
      kind: 'openai',
      baseUrl: 'https://api.acme.example/v1',
      icon: './gateway.png',
      regions: [
        { id: 'global', baseUrl: 'https://api.acme.example/v1' },
        { id: 'cn', baseUrl: 'https://api.acme.example.cn/v1' },
      ],
    },
  ],
  ...over,
})

const index = {
  schemaVersion: 1,
  plugins: [
    {
      id: 'acme',
      name: 'Acme Cloud',
      version: '1.1.0',
      description: 'Hosted gateway',
      homepage: 'https://acme.example',
      icon: 'icons/acme.svg',
      url: 'plugins/acme/plugin.json',
    },
    { id: 'beta', name: 'Beta' },
    { id: 'gamma', name: 'Gamma', url: `${FILES}plugins/gamma.json` },
    { id: 'legacy', name: 'Legacy', path: 'plugins/old-name.json' },
    { id: 'elsewhere', name: 'Elsewhere', url: 'https://evil.example/plugin.json' },
    { id: 'beta', name: 'Duplicate beta' },
    { id: 'Bad ID', name: 'Skipped' },
    { id: 'escape', name: 'Escape', path: '../outside.json' },
    'not an object',
  ],
}

type Routes = Record<string, string | number>

function fakeFetch(routes: Routes) {
  return vi.fn(async (input: URL | string) => {
    const route = routes[String(input)]
    if (route === undefined) return new Response('missing', { status: 404 })
    if (typeof route === 'number') return new Response(null, { status: route })
    return new Response(route)
  })
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-catalog-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function setup(routes: Routes, now = () => 0) {
  const fetch = fakeFetch(routes)
  const plugins = createProviderPluginService({ dir: path.join(dir, 'provider-plugins') })
  const catalog = createProviderCatalogService({
    plugins,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now,
  })
  return { fetch, plugins, catalog }
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError)
    return (error as RpcError).code
  }
  throw new Error('expected an error')
}

describe('official provider catalog (ADR-0050)', () => {
  it('lists valid entries from index.json and resolves their icons in the repository', async () => {
    const { catalog, fetch } = setup({ [`${FILES}index.json`]: JSON.stringify(index) })
    const listed = await catalog.list()
    expect(listed.source).toBe('https://github.com/960602906/cairn-provider-plugins')
    expect(listed.plugins).toEqual([
      {
        id: 'acme',
        name: 'Acme Cloud',
        version: '1.1.0',
        description: 'Hosted gateway',
        homepage: 'https://acme.example',
        icon: `${FILES}icons/acme.svg`,
      },
      { id: 'beta', name: 'Beta' },
      { id: 'gamma', name: 'Gamma' },
      { id: 'legacy', name: 'Legacy' },
    ])
    // 一分钟内复用目录
    await catalog.list()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://raw.githubusercontent.com/960602906/cairn-provider-plugins/main/index.json',
    )
  })

  it('previews a plugin from the repository, then installs exactly that content', async () => {
    const text = JSON.stringify(plugin())
    const { catalog, plugins } = setup({
      [`${FILES}index.json`]: JSON.stringify(index),
      [`${FILES}plugins/acme/plugin.json`]: text,
    })
    const preview = await catalog.preview({ id: 'acme' })
    expect(preview.sha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(preview.replaces).toBe(false)
    expect(preview.plugin).toMatchObject({
      id: 'acme',
      icon: `${FILES}icons/acme.svg`,
      templates: [{ id: 'acme.gateway', icon: `${FILES}gateway.png` }],
    })
    expect(plugins.list().plugins).toEqual([])

    const done = await catalog.install({ id: 'acme', sha256: preview.sha256 })
    expect(done).toMatchObject({ installed: true, replaces: false })
    // 相对图标一律相对仓库根目录；写入的是解析后的地址，之后扫描插件目录也能显示
    const installed = plugins.list().plugins
    expect(installed[0]).toMatchObject({ icon: `${FILES}icons/acme.svg` })
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'provider-plugins', 'acme.json'), 'utf8'),
    )
    expect(written.providers[0].icon).toBe(`${FILES}gateway.png`)
  })

  it('refuses to install content that changed after the preview', async () => {
    const routes: Routes = {
      [`${FILES}index.json`]: JSON.stringify(index),
      [`${FILES}plugins/acme/plugin.json`]: JSON.stringify(plugin()),
    }
    const { catalog } = setup(routes)
    const preview = await catalog.preview({ id: 'acme' })
    routes[`${FILES}plugins/acme/plugin.json`] = JSON.stringify(plugin({ version: '9' }))
    // 没有本次预览的内容时重新下载，再比对摘要
    expect(await codeOf(catalog.install({ id: 'acme', sha256: 'f'.repeat(64) }))).toBe(
      'providers.catalog.changed',
    )
    expect(await codeOf(catalog.install({ id: 'acme', sha256: preview.sha256 }))).toBe(
      'providers.catalog.changed',
    )
  })

  it('finds plugin files by url, path or the default location, and checks the plugin id', async () => {
    const { catalog, fetch } = setup({
      [`${FILES}index.json`]: JSON.stringify(index),
      [`${FILES}plugins/beta.json`]: JSON.stringify(plugin()),
      [`${FILES}plugins/gamma.json`]: JSON.stringify(plugin({ id: 'gamma' })),
      [`${FILES}plugins/old-name.json`]: JSON.stringify(plugin({ id: 'legacy' })),
    })
    expect(await codeOf(catalog.preview({ id: 'beta' }))).toBe('providers.catalog.invalid')
    expect((await catalog.preview({ id: 'gamma' })).plugin.id).toBe('gamma')
    expect((await catalog.preview({ id: 'legacy' })).plugin.id).toBe('legacy')
    // 指向仓库以外的项不出现，也不会被下载
    expect(await codeOf(catalog.preview({ id: 'elsewhere' }))).toBe('providers.catalog.not_found')
    expect(await codeOf(catalog.preview({ id: 'missing' }))).toBe('providers.catalog.not_found')
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://evil.example/plugin.json',
    )
  })

  it('asks for a newer Cairn when the index format is newer', async () => {
    const { catalog } = setup({
      [`${FILES}index.json`]: JSON.stringify({ schemaVersion: 2, plugins: [] }),
    })
    expect(await codeOf(catalog.list())).toBe('providers.catalog.unsupported_version')
  })

  it('reports an unreachable or invalid catalog clearly', async () => {
    expect(await codeOf(setup({}).catalog.list())).toBe('providers.catalog.unreachable')
    const down = setup({ [`${FILES}index.json`]: 503 })
    try {
      await down.catalog.list()
    } catch (error) {
      expect((error as RpcError).toInfo()).toEqual({
        code: 'providers.catalog.unreachable',
        params: { status: 503 },
      })
    }
    const offline = createProviderCatalogService({
      plugins: createProviderPluginService({ dir }),
      fetch: (async () => {
        throw new TypeError('offline')
      }) as unknown as typeof globalThis.fetch,
    })
    try {
      await offline.list()
    } catch (error) {
      expect((error as RpcError).toInfo()).toEqual({ code: 'providers.catalog.unreachable' })
    }
    for (const body of [
      '{',
      JSON.stringify({ schemaVersion: '1', plugins: [] }),
      'x'.repeat(600_000),
    ]) {
      expect(await codeOf(setup({ [`${FILES}index.json`]: body }).catalog.list())).toBe(
        'providers.catalog.invalid',
      )
    }
    // 插件文件本身无效时报插件的错误码
    const broken = setup({
      [`${FILES}index.json`]: JSON.stringify(index),
      [`${FILES}plugins/beta.json`]: '{"schemaVersion":1}',
    })
    expect(await codeOf(broken.catalog.preview({ id: 'beta' }))).toBe('providers.plugin.invalid')
  })

  it('can point at a local catalog for development and tests', async () => {
    const fetch = fakeFetch({
      'http://127.0.0.1:8123/index.json': JSON.stringify({ schemaVersion: 1, plugins: [] }),
    })
    const catalog = createProviderCatalogService({
      plugins: createProviderPluginService({ dir }),
      files: 'http://127.0.0.1:8123/',
      page: 'http://127.0.0.1:8123/',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(catalog.list()).resolves.toEqual({ source: 'http://127.0.0.1:8123/', plugins: [] })
  })

  it('serves the documented example index and plugin as a catalog', async () => {
    const examples = path.resolve(import.meta.dirname, '../../../../../docs/dev/examples')
    const { catalog } = setup({
      [`${FILES}index.json`]: fs.readFileSync(
        path.join(examples, 'provider-catalog-index.example.json'),
        'utf8',
      ),
      [`${FILES}plugins/acme.json`]: fs.readFileSync(
        path.join(examples, 'provider-plugin.example.json'),
        'utf8',
      ),
    })
    const listed = await catalog.list()
    expect(listed.plugins).toEqual([
      expect.objectContaining({ id: 'acme', icon: `${FILES}icons/acme.svg` }),
    ])
    const preview = await catalog.preview({ id: 'acme' })
    expect(preview.plugin.version).toBe(listed.plugins[0]!.version)
    expect(preview.plugin.icon).toBe(`${FILES}icons/acme.svg`)
    expect(preview.plugin.templates[0]).toMatchObject({
      homepage: 'https://acme.example/gateway',
      icon: `${FILES}icons/acme-gateway.png`,
    })
  })
})
