import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcError } from '@cairn/protocol'
import { createProviderPluginService } from './provider-plugin-service.js'

const plugin = (id: string, providers: unknown[] = []) => ({
  schemaVersion: 1,
  id,
  name: `Plugin ${id}`,
  providers:
    providers.length > 0
      ? providers
      : [{ id: 'gw', name: 'Gateway', kind: 'openai', baseUrl: `https://${id}.example.com/v1` }],
})

let root: string
let dir: string
let downloads: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-provider-plugins-'))
  dir = path.join(root, 'provider-plugins')
  downloads = path.join(root, 'downloads')
  fs.mkdirSync(downloads)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const write = (folder: string, name: string, content: unknown) => {
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, name)
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError)
    return (error as RpcError).code
  }
  throw new Error('expected an error')
}

describe('provider plugin service (ADR-0050)', () => {
  it('lists nothing when the folder does not exist', () => {
    const service = createProviderPluginService({ dir })
    expect(service.list()).toEqual({ plugins: [], skipped: [] })
  })

  it('lists valid plugins and reports files that cannot be loaded', () => {
    write(dir, 'a.json', plugin('acme'))
    write(dir, 'b.json', plugin('acme'))
    write(dir, 'broken.json', '{')
    write(dir, 'future.json', { ...plugin('future'), schemaVersion: 9 })
    write(dir, 'big.json', ' '.repeat(256 * 1024 + 1))
    write(dir, 'notes.txt', 'ignored')
    fs.mkdirSync(path.join(dir, 'folder.json'))
    const service = createProviderPluginService({ dir })
    const { plugins, skipped } = service.list()
    expect(plugins.map((p) => [p.id, p.templates.map((t) => t.id)])).toEqual([
      ['acme', ['acme.gw']],
    ])
    expect(skipped).toEqual([
      { file: 'b.json', code: 'providers.plugin.duplicate' },
      { file: 'big.json', code: 'providers.plugin.too_large' },
      { file: 'broken.json', code: 'providers.plugin.invalid' },
      { file: 'folder.json', code: 'providers.plugin.invalid' },
      { file: 'future.json', code: 'providers.plugin.unsupported_version' },
    ])
  })

  it('previews before installing and writes the validated plugin by its id', () => {
    const source = write(downloads, 'whatever-name.json', { ...plugin('acme'), extra: 'dropped' })
    const service = createProviderPluginService({ dir })

    const preview = service.install({ path: source })
    expect(preview).toMatchObject({ installed: false, replaces: false, plugin: { id: 'acme' } })
    expect(fs.existsSync(dir)).toBe(false)

    const done = service.install({ path: source, confirm: true })
    expect(done).toMatchObject({ installed: true, replaces: false })
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'acme.json'), 'utf8'))
    expect(written).toEqual(plugin('acme'))
    expect(fs.readdirSync(dir)).toEqual(['acme.json'])
    expect(service.list().plugins.map((p) => p.id)).toEqual(['acme'])
  })

  it('replaces a plugin with the same id, including files with other names', () => {
    write(dir, 'old-copy.json', plugin('acme'))
    write(dir, 'zz-duplicate.json', plugin('acme'))
    const source = write(downloads, 'acme.json', {
      ...plugin('acme'),
      name: 'Acme v2',
    })
    const service = createProviderPluginService({ dir })
    expect(service.install({ path: source }).replaces).toBe(true)
    service.install({ path: source, confirm: true })
    expect(fs.readdirSync(dir)).toEqual(['acme.json'])
    expect(service.list().plugins.map((p) => p.name)).toEqual(['Acme v2'])

    // 选中的就是插件目录里的文件时原地覆盖
    expect(service.install({ path: path.join(dir, 'acme.json'), confirm: true }).installed).toBe(
      true,
    )
    expect(fs.readdirSync(dir)).toEqual(['acme.json'])
  })

  it('refuses invalid, missing, oversized and linked files', () => {
    const service = createProviderPluginService({ dir })
    expect(codeOf(() => service.install({ path: write(downloads, 'bad.json', '[]') }))).toBe(
      'providers.plugin.invalid',
    )
    expect(codeOf(() => service.install({ path: path.join(downloads, 'missing.json') }))).toBe(
      'providers.plugin.not_found',
    )
    const big = write(downloads, 'big.json', ' '.repeat(256 * 1024 + 1))
    expect(codeOf(() => service.install({ path: big }))).toBe('providers.plugin.too_large')
    const bad = plugin('acme', [{ id: 'x', name: 'X', kind: 'openai', baseUrl: 'ftp://x' }])
    try {
      service.install({ path: write(downloads, 'url.json', bad) })
    } catch (error) {
      expect((error as RpcError).toInfo()).toEqual({
        code: 'providers.plugin.invalid',
        params: { path: 'providers.0.baseUrl' },
      })
    }
    const target = write(downloads, 'real.json', plugin('acme'))
    const link = path.join(downloads, 'link.json')
    try {
      fs.symlinkSync(target, link)
    } catch {
      return
    }
    expect(codeOf(() => service.install({ path: link }))).toBe('providers.plugin.invalid')
  })

  it('removes every file of a plugin and reports unknown ids', () => {
    write(dir, 'acme.json', plugin('acme'))
    write(dir, 'acme-copy.json', plugin('acme'))
    write(dir, 'other.json', plugin('other'))
    const service = createProviderPluginService({ dir })
    expect(service.remove({ id: 'acme' })).toEqual({})
    expect(fs.readdirSync(dir)).toEqual(['other.json'])
    expect(codeOf(() => service.remove({ id: 'acme' }))).toBe('providers.plugin.not_found')
    expect(codeOf(() => service.remove({ id: '../other' }))).toBe('providers.plugin.not_found')
  })

  it('installs the documented example plugin', () => {
    const example = path.resolve(
      import.meta.dirname,
      '../../../../../docs/dev/examples/provider-plugin.example.json',
    )
    const { plugin: info } = createProviderPluginService({ dir }).install({ path: example })
    expect(info.templates.map((t) => [t.id, t.category, t.requiresKey])).toEqual([
      ['acme.gateway', 'relay', true],
      ['acme.workstation', 'local', false],
    ])
    expect(info.templates[0]!.regions?.map((r) => r.id)).toEqual(['global', 'cn'])
    expect(info.templates[1]!.models[0]).toMatchObject({
      id: 'acme-local-7b',
      supportsTools: true,
      supportsParallelToolCalls: false,
    })
  })

  it('picks a file through the injected dialog', async () => {
    await expect(createProviderPluginService({ dir }).pick()).resolves.toEqual({})
    const picked = createProviderPluginService({ dir, pickFile: async () => '/tmp/acme.json' })
    await expect(picked.pick()).resolves.toEqual({ path: '/tmp/acme.json' })
    const cancelled = createProviderPluginService({ dir, pickFile: async () => undefined })
    await expect(cancelled.pick()).resolves.toEqual({})
  })

  it('rethrows unexpected file system errors', () => {
    expect(() => createProviderPluginService({ dir: `${dir}\0` }).list()).toThrow()
    expect(() =>
      createProviderPluginService({ dir }).install({ path: `${downloads}\0x.json` }),
    ).toThrow(TypeError)
  })

  it('treats a file in place of the plugin folder as no plugins', () => {
    const file = write(root, 'not-a-dir', 'x')
    expect(createProviderPluginService({ dir: file }).list()).toEqual({ plugins: [], skipped: [] })
  })
})
