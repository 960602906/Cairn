import { describe, expect, it } from 'vitest'
import { findTemplate } from '@cairn/core'
import type { ProviderConfig } from '@cairn/protocol'
import {
  configOf,
  draftOf,
  enabledModelIdsOf,
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
    expect(templatesOf('openai').map((t) => t.id)).toEqual(['deepseek', 'openai'])
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

  it('tests every enabled model', () => {
    const models = [
      { ...GENERIC_MODEL_DEFAULTS, id: 'off', enabled: false },
      { ...GENERIC_MODEL_DEFAULTS, id: 'a' },
      { ...GENERIC_MODEL_DEFAULTS, id: 'b' },
    ]
    expect(enabledModelIdsOf(models)).toEqual(['a', 'b'])
    expect(enabledModelIdsOf([models[0]!])).toEqual([])
  })
})
