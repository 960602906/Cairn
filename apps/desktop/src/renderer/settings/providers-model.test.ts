import { describe, expect, it } from 'vitest'
import { findTemplate } from '@cairn/core'
import type { ProviderConfig } from '@cairn/protocol'
import {
  catalogGroups,
  catalogOf,
  configOf,
  credentialRefFor,
  draftOf,
  enabledModelIdsOf,
  hostOf,
  iconSourceOf,
  pluginIconSourceOf,
  formatTokens,
  initials,
  logoColor,
  modelDefaults,
  modelRowsOf,
  newDraft,
  problemsOf,
  profileFrom,
  slugId,
  sourceOf,
  templatesOf,
  testTargetOf,
  uniqueProviderId,
  GENERIC_MODEL_DEFAULTS,
} from './providers-model.js'

const p = (id: string) =>
  ({ id, kind: 'openai', displayName: id, baseUrl: 'https://x', models: [] }) as ProviderConfig

describe('providers-model', () => {
  it('makes unique ids and slugs', () => {
    expect(uniqueProviderId('a', [])).toBe('a')
    expect(uniqueProviderId('a', [p('a'), p('a-2')])).toBe('a-3')
    expect(slugId('  My Relay!! ')).toBe('my-relay')
    expect(slugId('公司网关')).toBe('custom')
  })

  it('tells official from relay by the template address', () => {
    expect(sourceOf({ template: 'deepseek', baseUrl: 'https://api.deepseek.com/' })).toBe(
      'official',
    )
    expect(sourceOf({ template: 'deepseek', baseUrl: 'http://127.0.0.1:3425/v1' })).toBe('relay')
    expect(sourceOf({ baseUrl: 'https://api.deepseek.com' })).toBe('relay')
    // 任一接入点都算官方
    expect(
      sourceOf({ template: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
    ).toBe('official')
    // 找不到模板（如插件已卸载）时按中转处理
    expect(sourceOf({ template: 'gone.plugin', baseUrl: 'https://x' })).toBe('relay')
    const openai = templatesOf('openai').map((t) => t.id)
    expect(openai).toEqual(expect.arrayContaining(['deepseek', 'openai', 'qwen', 'openrouter']))
    expect(openai).not.toContain('anthropic')
    expect(templatesOf('anthropic').map((t) => t.id)).toEqual(['anthropic'])
  })

  it('merges plugin templates into the catalog and groups it by category', () => {
    const plugin = {
      id: 'acme',
      name: 'Acme',
      templates: [
        {
          ...findTemplate('openrouter')!,
          id: 'acme.gw',
          displayName: 'Acme Gateway',
          baseUrl: 'https://gw.acme.example/v1',
          pluginId: 'acme',
        },
      ],
    }
    expect(catalogOf(undefined)).toBe(catalogOf([]))
    const catalog = catalogOf([plugin])
    expect(catalog.at(-1)?.id).toBe('acme.gw')
    expect(sourceOf({ template: 'acme.gw', baseUrl: 'https://gw.acme.example/v1' }, catalog)).toBe(
      'official',
    )
    expect(modelDefaults('acme.gw', catalog)).toBe(plugin.templates[0]!.modelDefaults)

    const groups = catalogGroups(catalog)
    expect(groups.map((g) => g.category)).toEqual(['vendor', 'relay', 'local'])
    expect(groups[0]!.templates[0]!.id).toBe('deepseek')
    expect(groups[1]!.templates.map((t) => t.id)).toContain('acme.gw')
    expect(groups[2]!.templates.map((t) => t.id)).toEqual(['ollama', 'lmstudio'])
    // 按名称、id 或主机名搜索，大小写不敏感
    expect(catalogGroups(catalog, 'ACME')[0]!.templates.map((t) => t.id)).toEqual(['acme.gw'])
    expect(catalogGroups(catalog, 'bigmodel.cn')[0]!.templates.map((t) => t.id)).toEqual(['zhipu'])
    expect(catalogGroups(catalog, 'nothing-matches')).toEqual([])
    expect(hostOf('https://API.Example.com:8443/v1?x')).toBe('api.example.com:8443')
    expect(hostOf('not a url')).toBe('not a url')
  })

  it('builds icon sources from templates and plugins', () => {
    const kimi = findTemplate('moonshot')!
    expect(iconSourceOf(kimi)).toEqual({
      homepage: 'https://www.moonshot.ai',
      keysUrl: 'https://platform.moonshot.ai/console/api-keys',
      baseUrl: 'https://api.moonshot.ai/v1',
    })
    const qwen = findTemplate('qwen')!
    expect(iconSourceOf({ ...qwen, icon: 'https://cdn.example/q.svg' })).toMatchObject({
      icon: 'https://cdn.example/q.svg',
      keysUrl: qwen.regions![0]!.keysUrl,
    })
    expect(iconSourceOf({ baseUrl: 'http://localhost:1234/v1' })).toEqual({
      baseUrl: 'http://localhost:1234/v1',
    })
    // 插件自己的图标与网站优先，其余取第一个服务的
    expect(pluginIconSourceOf({ homepage: 'https://acme.example', templates: [kimi] })).toEqual({
      ...iconSourceOf(kimi),
      homepage: 'https://acme.example',
    })
    expect(pluginIconSourceOf({ icon: 'data:image/png;base64,AA' })).toEqual({
      icon: 'data:image/png;base64,AA',
    })
    expect(pluginIconSourceOf({ templates: [] })).toBeUndefined()
  })

  it('picks the endpoint by locale for services with regions', () => {
    const qwen = findTemplate('qwen')!
    expect(newDraft(qwen, 'zh-CN').baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
    expect(newDraft(qwen, 'en-US').baseUrl).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    )
    expect(newDraft(findTemplate('deepseek')!, 'zh-CN').baseUrl).toBe('https://api.deepseek.com')
  })

  it('gives a credential reference only when a key may be needed', () => {
    const saved = { ...p('x'), credentialRef: 'old-ref' }
    const ollama = findTemplate('ollama')
    const kimi = findTemplate('moonshot')
    expect(credentialRefFor(saved, 'x', kimi, false)).toBe('old-ref')
    expect(credentialRefFor(p('x'), 'x', undefined, false)).toBeUndefined()
    expect(credentialRefFor(p('x'), 'x', undefined, true)).toBe('x')
    expect(credentialRefFor(undefined, 'new', kimi, false)).toBe('new')
    expect(credentialRefFor(undefined, 'new', undefined, false)).toBe('new')
    expect(credentialRefFor(undefined, 'ollama', ollama, false)).toBeUndefined()
    expect(credentialRefFor(undefined, 'ollama', ollama, true)).toBe('ollama')
  })

  it('draws initials, colors and token sizes', () => {
    expect(initials('DeepSeek')).toBe('D')
    expect(initials('Google Gemini')).toBe('GG')
    expect(initials('公司网关')).toBe('公')
    expect(initials('  ')).toBe('?')
    expect(logoColor('deepseek')).toBe('#4d6bfe')
    expect(logoColor(undefined)).toBe('#2d2f36')
    expect(formatTokens(1_048_576)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(512)).toBe('512')
  })

  it('builds model profiles from fetched models', () => {
    expect(modelDefaults(undefined)).toBe(GENERIC_MODEL_DEFAULTS)
    expect(modelDefaults('gemini')).toBe(findTemplate('gemini')!.modelDefaults)
    expect(profileFrom({ id: 'x', displayName: 'x' }, undefined)).toEqual({
      ...GENERIC_MODEL_DEFAULTS,
      id: 'x',
    })
    expect(
      profileFrom({ id: 'y', displayName: 'Y', contextWindow: 10, maxOutputTokens: 5 }, 'openai'),
    ).toMatchObject({ id: 'y', displayName: 'Y', contextWindow: 10, maxOutputTokens: 5 })
  })

  it('converts drafts to configurations', () => {
    const draft = newDraft()
    expect(draft).toMatchObject({ kind: 'openai', template: 'deepseek' })
    expect(problemsOf(draft)).toEqual({})
    expect(problemsOf({ ...draft, displayName: ' ', baseUrl: 'ftp://x' })).toEqual({
      displayName: true,
      baseUrl: true,
    })
    const config = configOf(
      { ...draft, displayName: ' DS ', baseUrl: ' https://a/v1 ' },
      'ds',
      'ds',
    )
    expect(config).toMatchObject({
      id: 'ds',
      displayName: 'DS',
      baseUrl: 'https://a/v1',
      credentialRef: 'ds',
      template: 'deepseek',
      compat: { thinkingFormat: 'deepseek' },
    })
    // 兼容参数只对 OpenAI 格式；空的不写
    expect(configOf({ ...draft, kind: 'anthropic' }, 'a', 'a')).not.toHaveProperty('compat')
    expect(configOf({ ...draft, compat: {} }, 'a', undefined)).not.toHaveProperty('compat')
    expect(configOf({ ...draft, template: undefined }, 'a', undefined)).not.toHaveProperty(
      'credentialRef',
    )
    expect(draftOf(config)).toMatchObject({ displayName: 'DS', template: 'deepseek' })
  })

  it('keeps the fetched catalog as a cache', () => {
    const catalog = [{ id: 'a' }, { id: 'b', displayName: 'B', contextWindow: 200_000 }]
    const config = configOf({ ...newDraft(), catalog }, 'p', undefined)
    expect(config.catalog).toEqual(catalog)
    expect(draftOf(config).catalog).toEqual(catalog)
    // 空的目录不写进配置
    expect(configOf({ ...newDraft(), catalog: [] }, 'p', undefined)).not.toHaveProperty('catalog')
  })

  it('merges fetched models into one list after the configured ones', () => {
    const models = [
      { ...GENERIC_MODEL_DEFAULTS, id: 'a' },
      { ...GENERIC_MODEL_DEFAULTS, id: 'off', enabled: false },
    ]
    expect(
      modelRowsOf(models, [{ id: 'a' }, { id: 'c' }, { id: 'd', contextWindow: 1_000 }]),
    ).toEqual([
      {
        id: 'a',
        displayName: undefined,
        contextWindow: GENERIC_MODEL_DEFAULTS.contextWindow,
        profile: models[0],
      },
      {
        id: 'off',
        displayName: undefined,
        contextWindow: GENERIC_MODEL_DEFAULTS.contextWindow,
        profile: models[1],
      },
      { id: 'c', displayName: undefined, contextWindow: undefined },
      { id: 'd', displayName: undefined, contextWindow: 1_000 },
    ])
    expect(modelRowsOf([], undefined)).toEqual([])
  })

  it('tests the default model, or the first enabled one', () => {
    const models = [
      { ...GENERIC_MODEL_DEFAULTS, id: 'off', enabled: false },
      { ...GENERIC_MODEL_DEFAULTS, id: 'a' },
      { ...GENERIC_MODEL_DEFAULTS, id: 'b' },
    ]
    expect(testTargetOf(models, 'b')).toBe('b')
    expect(testTargetOf(models, undefined)).toBe('a')
    expect(testTargetOf(models, 'off')).toBe('a')
    expect(testTargetOf([models[0]!], undefined)).toBeUndefined()
  })

  it('lists every enabled model', () => {
    const models = [
      { ...GENERIC_MODEL_DEFAULTS, id: 'off', enabled: false },
      { ...GENERIC_MODEL_DEFAULTS, id: 'a' },
      { ...GENERIC_MODEL_DEFAULTS, id: 'b' },
    ]
    expect(enabledModelIdsOf(models)).toEqual(['a', 'b'])
    expect(enabledModelIdsOf([models[0]!])).toEqual([])
  })
})
