import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@nexus/protocol'
import { createSettingsService } from './settings-service.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const read = () => JSON.parse(readFileSync(file, 'utf8')) as unknown

describe('createSettingsService', () => {
  it('follows the system language until a locale is saved', () => {
    const onError = vi.fn()
    expect(
      createSettingsService({ file, systemLocales: () => ['zh-Hans-CN'], onError }).get(),
    ).toEqual({
      locale: 'zh-CN',
    })
    expect(createSettingsService({ file, systemLocales: () => ['fr-FR'], onError }).get()).toEqual({
      locale: 'en-US',
    })
    expect(onError).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('saves updates and reads them back on the next start', () => {
    const settings = createSettingsService({ file, systemLocales: () => ['zh-CN'] })
    expect(settings.update({ locale: 'en-US' })).toEqual({ locale: 'en-US' })
    expect(settings.get()).toEqual({ locale: 'en-US' })
    expect(read()).toEqual({ locale: 'en-US' })
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(createSettingsService({ file, systemLocales: () => ['zh-CN'] }).get()).toEqual({
      locale: 'en-US',
    })
  })

  it('keeps unknown fields written by other versions', () => {
    writeFileSync(file, JSON.stringify({ locale: 'zh-CN', theme: 'dark' }))
    const settings = createSettingsService({ file, systemLocales: () => ['en-US'] })
    expect(settings.get()).toEqual({ locale: 'zh-CN' })
    settings.update({ locale: 'en-US' })
    expect(read()).toEqual({ locale: 'en-US', theme: 'dark' })
  })

  it('leaves settings that are missing or undefined in the patch unchanged', () => {
    writeFileSync(file, JSON.stringify({ locale: 'en-US' }))
    const settings = createSettingsService({ file, systemLocales: () => ['zh-CN'] })
    expect(settings.update({})).toEqual({ locale: 'en-US' })
    expect(settings.update({ locale: undefined })).toEqual({ locale: 'en-US' })
    expect(read()).toEqual({ locale: 'en-US' })
  })

  it.each([
    ['invalid JSON', '{ not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"zh-CN"'],
  ])('falls back to defaults when the file holds %s', (_name, content) => {
    writeFileSync(file, content)
    const onError = vi.fn()
    const settings = createSettingsService({ file, systemLocales: () => ['zh-CN'], onError })
    expect(settings.get()).toEqual({ locale: 'zh-CN' })
    expect(onError).toHaveBeenCalledOnce()
    settings.update({ locale: 'en-US' })
    expect(read()).toEqual({ locale: 'en-US' })
  })

  it('uses the system language when the saved locale is not supported', () => {
    writeFileSync(file, JSON.stringify({ locale: 'fr-FR' }))
    expect(createSettingsService({ file, systemLocales: () => ['zh-TW'] }).get()).toEqual({
      locale: 'zh-CN',
    })
  })

  it('reports unreadable files and still starts', () => {
    // 同名目录：读取失败但不是 ENOENT
    mkdirSync(file)
    const onError = vi.fn()
    expect(createSettingsService({ file, systemLocales: () => [], onError }).get()).toEqual({
      locale: 'en-US',
    })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('fails with settings.write_failed and keeps the previous settings', () => {
    const onError = vi.fn()
    const settings = createSettingsService({
      file: join(dir, 'missing', 'settings.json'),
      systemLocales: () => ['zh-CN'],
      onError,
    })
    let thrown: unknown
    try {
      settings.update({ locale: 'en-US' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RpcError)
    expect((thrown as RpcError).toInfo()).toEqual({ code: 'settings.write_failed' })
    expect(onError).toHaveBeenCalledOnce()
    expect(settings.get()).toEqual({ locale: 'zh-CN' })
  })
})
