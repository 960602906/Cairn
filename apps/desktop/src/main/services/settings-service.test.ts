import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@nexus/protocol'
import { createMemoryStorage } from '@nexus/storage'
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
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => ['zh-Hans-CN'],
        onError,
      }).get(),
    ).toEqual({ locale: 'zh-CN', providers: [] })
    expect(
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => ['fr-FR'],
        onError,
      }).get(),
    ).toEqual({ locale: 'en-US', providers: [] })
    expect(onError).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('saves the permission mode; defaults to ask when missing or invalid', () => {
    writeFileSync(file, JSON.stringify({ permissionMode: 'yolo' }))
    const settings = createSettingsService({
      storage: createMemoryStorage(),
      file,
      systemLocales: () => ['zh-CN'],
    })
    expect(settings.get()).toEqual({ locale: 'zh-CN', providers: [] })
    expect(settings.permissionMode()).toBe('ask')
    expect(settings.update({ permissionMode: 'read-only' })).toEqual({
      locale: 'zh-CN',
      providers: [],
      permissionMode: 'read-only',
    })
    expect(settings.permissionMode()).toBe('read-only')
    expect(read()).toEqual({ permissionMode: 'read-only' })
    settings.update({ locale: 'en-US' })
    expect(
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => ['zh-CN'],
      }).permissionMode(),
    ).toBe('read-only')
  })

  it('saves the custom instructions; blank or null clears them (M1-13b)', () => {
    writeFileSync(file, JSON.stringify({ instructions: 42 }))
    const settings = createSettingsService({
      storage: createMemoryStorage(),
      file,
      systemLocales: () => ['zh-CN'],
    })
    expect(settings.get()).toEqual({ locale: 'zh-CN', providers: [] })
    expect(settings.instructions()).toBeUndefined()
    expect(settings.update({ instructions: 'Use pnpm.' })).toEqual({
      locale: 'zh-CN',
      providers: [],
      instructions: 'Use pnpm.',
    })
    expect(settings.instructions()).toBe('Use pnpm.')
    expect(
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => ['zh-CN'],
      }).instructions(),
    ).toBe('Use pnpm.')
    settings.update({ instructions: '  \n' })
    expect(settings.instructions()).toBeUndefined()
    expect(read()).toEqual({})
    settings.update({ instructions: 'again' })
    settings.update({ instructions: null })
    expect(settings.get()).toEqual({ locale: 'zh-CN', providers: [] })
  })

  it('saves updates and reads them back on the next start', () => {
    const settings = createSettingsService({
      storage: createMemoryStorage(),
      file,
      systemLocales: () => ['zh-CN'],
    })
    expect(settings.update({ locale: 'en-US' })).toEqual({ locale: 'en-US', providers: [] })
    expect(settings.get()).toEqual({ locale: 'en-US', providers: [] })
    expect(read()).toEqual({ locale: 'en-US' })
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => ['zh-CN'],
      }).get(),
    ).toEqual({ locale: 'en-US', providers: [] })
  })

  it('keeps unknown fields written by other versions', () => {
    writeFileSync(file, JSON.stringify({ locale: 'zh-CN', theme: 'dark' }))
    const settings = createSettingsService({
      storage: createMemoryStorage(),
      file,
      systemLocales: () => ['en-US'],
    })
    expect(settings.get()).toEqual({ locale: 'zh-CN', providers: [] })
    settings.update({ locale: 'en-US' })
    expect(read()).toEqual({ locale: 'en-US', theme: 'dark' })
  })

  it('leaves settings that are missing or undefined in the patch unchanged', () => {
    writeFileSync(file, JSON.stringify({ locale: 'en-US' }))
    const settings = createSettingsService({
      storage: createMemoryStorage(),
      file,
      systemLocales: () => ['zh-CN'],
    })
    expect(settings.update({})).toEqual({ locale: 'en-US', providers: [] })
    expect(settings.update({ locale: undefined })).toEqual({ locale: 'en-US', providers: [] })
    expect(read()).toEqual({ locale: 'en-US' })
  })

  it.each([
    ['invalid JSON', '{ not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"zh-CN"'],
  ])('falls back to defaults when the file holds %s', (_name, content) => {
    writeFileSync(file, content)
    const onError = vi.fn()
    const settings = createSettingsService({
      storage: createMemoryStorage(),
      file,
      systemLocales: () => ['zh-CN'],
      onError,
    })
    expect(settings.get()).toEqual({ locale: 'zh-CN', providers: [] })
    expect(onError).toHaveBeenCalledOnce()
    settings.update({ locale: 'en-US' })
    expect(read()).toEqual({ locale: 'en-US' })
  })

  it('uses the system language when the saved locale is not supported', () => {
    writeFileSync(file, JSON.stringify({ locale: 'fr-FR' }))
    expect(
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => ['zh-TW'],
      }).get(),
    ).toEqual({ locale: 'zh-CN', providers: [] })
  })

  it('reports unreadable files and still starts', () => {
    // 同名目录：读取失败但不是 ENOENT
    mkdirSync(file)
    const onError = vi.fn()
    expect(
      createSettingsService({
        storage: createMemoryStorage(),
        file,
        systemLocales: () => [],
        onError,
      }).get(),
    ).toEqual({ locale: 'en-US', providers: [] })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('fails with settings.write_failed and keeps the previous settings', () => {
    const onError = vi.fn()
    const settings = createSettingsService({
      storage: createMemoryStorage(),
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
    expect(settings.get()).toEqual({ locale: 'zh-CN', providers: [] })
  })
})

describe('model settings', () => {
  const model = {
    id: 'deepseek-chat',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: false,
  }
  const deepseek = {
    id: 'deepseek',
    kind: 'openai' as const,
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    credentialRef: 'deepseek',
    models: [model],
  }
  const ollama = {
    id: 'ollama',
    kind: 'openai' as const,
    displayName: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: [{ ...model, id: 'qwen3' }],
  }
  const ref = { providerId: 'deepseek', modelId: 'deepseek-chat' }
  const setup = () => {
    const storage = createMemoryStorage()
    const settings = createSettingsService({ storage, file, systemLocales: () => ['zh-CN'] })
    return { storage, settings }
  }

  it('saves providers in storage and the default model in the file', () => {
    const { storage, settings } = setup()
    expect(settings.update({ providers: [deepseek, ollama], defaultModel: ref })).toEqual({
      locale: 'zh-CN',
      providers: [deepseek, ollama],
      defaultModel: ref,
    })
    expect(storage.providers.list()).toEqual([deepseek, ollama])
    expect(read()).toEqual({ defaultModel: ref })
    expect(settings.provider('ollama')).toEqual(ollama)
    expect(settings.provider('missing')).toBeUndefined()
    expect(settings.hasModel(ref)).toBe(true)
    expect(settings.hasModel({ providerId: 'deepseek', modelId: 'qwen3' })).toBe(false)
    expect(settings.hasModel({ providerId: 'missing', modelId: 'x' })).toBe(false)

    const reopened = createSettingsService({ storage, file, systemLocales: () => ['zh-CN'] })
    expect(reopened.get().defaultModel).toEqual(ref)
  })

  it('rejects a default model that is not configured', () => {
    const { settings } = setup()
    settings.update({ providers: [ollama] })
    for (const defaultModel of [ref, { providerId: 'ollama', modelId: 'deepseek-chat' }]) {
      let thrown: unknown
      try {
        settings.update({ defaultModel })
      } catch (error) {
        thrown = error
      }
      expect((thrown as RpcError).toInfo()).toMatchObject({
        code: 'settings.invalid_default_model',
      })
    }
    // 同一次更新中加入的提供方可以作为默认模型
    expect(
      settings.update({ providers: [ollama, deepseek], defaultModel: ref }).defaultModel,
    ).toEqual(ref)
  })

  it('clears the default model with null or when its provider or model is removed', () => {
    const { settings } = setup()
    settings.update({ providers: [deepseek, ollama], defaultModel: ref })
    expect(settings.update({ defaultModel: null })).not.toHaveProperty('defaultModel')
    expect(read()).toEqual({})

    settings.update({ defaultModel: ref })
    expect(
      settings.update({ providers: [{ ...deepseek, models: [] }, ollama] }),
    ).not.toHaveProperty('defaultModel')
    expect(read()).toEqual({})
  })

  it('ignores an invalid or unknown default model in the file', () => {
    const { storage } = setup()
    storage.providers.replaceAll([deepseek])
    for (const defaultModel of [
      { providerId: 'deepseek' },
      'x',
      { providerId: 'gone', modelId: 'm' },
    ]) {
      writeFileSync(file, JSON.stringify({ defaultModel }))
      const settings = createSettingsService({ storage, file, systemLocales: () => ['zh-CN'] })
      expect(settings.get()).not.toHaveProperty('defaultModel')
    }
  })

  it('keeps the previous providers when the file cannot be written', () => {
    const storage = createMemoryStorage()
    storage.providers.replaceAll([ollama])
    const onError = vi.fn()
    const settings = createSettingsService({
      storage,
      file: join(dir, 'missing', 'settings.json'),
      systemLocales: () => ['zh-CN'],
      onError,
    })
    expect(() => settings.update({ providers: [deepseek] })).toThrow(RpcError)
    expect(storage.providers.list()).toEqual([ollama])
    expect(onError).toHaveBeenCalledOnce()
  })

  it('gives the host model config with merged compat and the credential ref', () => {
    const { settings } = setup()
    const proxy = {
      ...deepseek,
      id: 'gateway',
      baseUrl: 'http://127.0.0.1:3425/v1',
      compat: { thinkingFormat: 'deepseek' as const, maxTokensField: 'max_tokens' as const },
      models: [
        {
          ...model,
          id: 'group/smart-split',
          compat: { maxTokensField: 'max_completion_tokens' as const },
        },
      ],
    }
    settings.update({ providers: [proxy, ollama] })
    expect(
      settings.hostModelConfig({ providerId: 'gateway', modelId: 'group/smart-split' }),
    ).toEqual({
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:3425/v1',
      profile: {
        id: 'group/smart-split',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsParallelToolCalls: true,
        supportsReasoning: false,
      },
      compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_completion_tokens' },
    })
    expect(settings.hostModelConfig({ providerId: 'fake', modelId: 'fake' })).toBeUndefined()
    expect(() => settings.hostModelConfig({ providerId: 'gateway', modelId: 'gone' })).toThrow(
      expect.objectContaining({ code: 'session.unknown_model' }),
    )
    expect(settings.credentialRef({ providerId: 'gateway', modelId: 'x' })).toBe('deepseek')
    expect(settings.credentialRef({ providerId: 'ollama', modelId: 'qwen3' })).toBeUndefined()
    expect(settings.credentialRef({ providerId: 'fake', modelId: 'x' })).toBeUndefined()
  })
})
