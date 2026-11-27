import { describe, expect, it } from 'vitest'
import { ProviderTemplateSpec } from '@cairn/protocol'
import {
  parseProviderPlugin,
  ProviderPluginError,
  ProviderPluginErrorCode,
  providerPluginInfo,
} from './provider-plugins.js'
import { GENERIC_MODEL_DEFAULTS } from './provider-templates.js'

const manifest = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'acme',
  name: 'Acme Cloud',
  version: '1.0.0',
  providers: [
    {
      id: 'gateway',
      name: 'Acme Gateway',
      kind: 'openai',
      baseUrl: 'https://api.acme.example/v1',
      keysUrl: 'https://acme.example/keys',
      compat: { maxTokensField: 'max_tokens' },
      models: [{ id: 'acme-large', contextWindow: 200000 }, { id: 'acme-small' }],
      modelDefaults: { contextWindow: 64000, supportsReasoning: true },
    },
  ],
  ...over,
})

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderPluginError)
    return (error as ProviderPluginError).code
  }
  throw new Error('expected an error')
}

describe('provider plugins (ADR-0049)', () => {
  it('expands a plugin into namespaced catalog templates with defaults filled in', () => {
    const info = providerPluginInfo(parseProviderPlugin(JSON.stringify(manifest())))
    expect(info).toMatchObject({ id: 'acme', name: 'Acme Cloud', version: '1.0.0' })
    const [template] = info.templates
    expect(ProviderTemplateSpec.safeParse(template).success).toBe(true)
    expect(template).toMatchObject({
      id: 'acme.gateway',
      kind: 'openai',
      category: 'relay',
      requiresKey: true,
      pluginId: 'acme',
      keysUrl: 'https://acme.example/keys',
      compat: { maxTokensField: 'max_tokens' },
      modelDefaults: {
        ...GENERIC_MODEL_DEFAULTS,
        contextWindow: 64000,
        supportsReasoning: true,
      },
    })
    expect(template!.models).toEqual([
      {
        id: 'acme-large',
        ...GENERIC_MODEL_DEFAULTS,
        contextWindow: 200000,
        supportsReasoning: true,
      },
      {
        id: 'acme-small',
        ...GENERIC_MODEL_DEFAULTS,
        contextWindow: 64000,
        supportsReasoning: true,
      },
    ])
  })

  it('keeps optional fields only when given and ignores unknown top-level fields', () => {
    const info = providerPluginInfo(
      parseProviderPlugin(
        JSON.stringify({
          schemaVersion: 1,
          id: 'local-pack',
          name: 'Local pack',
          homepage: 'https://example.com/pack',
          description: 'Local servers',
          futureField: true,
          providers: [
            {
              id: 'vllm',
              name: 'vLLM',
              kind: 'openai',
              category: 'local',
              requiresKey: false,
              baseUrl: 'http://localhost:8000/v1',
              suggestedModels: ['qwen3'],
              models: [
                {
                  id: 'm',
                  displayName: 'M',
                  thinkingLevel: 'low',
                  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
                },
              ],
            },
            {
              id: 'cn-relay',
              name: 'Relay',
              kind: 'anthropic',
              baseUrl: 'https://relay.example.com',
              regions: [
                { id: 'global', baseUrl: 'https://relay.example.com' },
                { id: 'cn', baseUrl: 'https://relay.example.cn' },
              ],
            },
          ],
        }),
      ),
    )
    expect(info).toMatchObject({
      homepage: 'https://example.com/pack',
      description: 'Local servers',
    })
    expect(info).not.toHaveProperty('version')
    expect(info.templates[0]).toMatchObject({
      id: 'local-pack.vllm',
      category: 'local',
      requiresKey: false,
      suggestedModels: ['qwen3'],
      models: [
        { id: 'm', displayName: 'M', thinkingLevel: 'low', pricing: { inputPerMillion: 1 } },
      ],
    })
    expect(info.templates[0]).not.toHaveProperty('keysUrl')
    expect(info.templates[1]!.regions).toHaveLength(2)
    expect(info.templates[1]).not.toHaveProperty('compat')
  })

  it('rejects broken files with a code and the failing path', () => {
    expect(codeOf(() => parseProviderPlugin('{not json'))).toBe(ProviderPluginErrorCode.Invalid)
    expect(
      codeOf(() => parseProviderPlugin('\uFEFF' + JSON.stringify(manifest({ schemaVersion: 2 })))),
    ).toBe(ProviderPluginErrorCode.UnsupportedVersion)
    expect(codeOf(() => parseProviderPlugin('x'.repeat(256 * 1024 + 1)))).toBe(
      ProviderPluginErrorCode.TooLarge,
    )
    expect(codeOf(() => parseProviderPlugin(JSON.stringify(manifest({ id: 'Bad ID' }))))).toBe(
      ProviderPluginErrorCode.Invalid,
    )
    try {
      parseProviderPlugin(
        JSON.stringify(
          manifest({
            providers: [{ id: 'x', name: 'X', kind: 'openai', baseUrl: 'ftp://nope' }],
          }),
        ),
      )
    } catch (error) {
      expect((error as ProviderPluginError).path).toBe('providers.0.baseUrl')
    }
    // 兼容参数里的未知字段报错，而不是被悄悄忽略
    expect(
      codeOf(() =>
        parseProviderPlugin(
          JSON.stringify(
            manifest({
              providers: [
                { id: 'x', name: 'X', kind: 'openai', baseUrl: 'https://x', compat: { nope: 1 } },
              ],
            }),
          ),
        ),
      ),
    ).toBe(ProviderPluginErrorCode.Invalid)
    // 外部链接只接受 https，条目 id 不能重复
    expect(
      codeOf(() =>
        parseProviderPlugin(
          JSON.stringify(
            manifest({
              providers: [
                { id: 'x', name: 'X', kind: 'openai', baseUrl: 'https://x', keysUrl: 'http://x' },
              ],
            }),
          ),
        ),
      ),
    ).toBe(ProviderPluginErrorCode.Invalid)
    const twice = { id: 'x', name: 'X', kind: 'openai', baseUrl: 'https://x' }
    expect(
      codeOf(() => parseProviderPlugin(JSON.stringify(manifest({ providers: [twice, twice] })))),
    ).toBe(ProviderPluginErrorCode.Invalid)
  })

  it('rejects a default address that is not one of the regions', () => {
    const parsed = parseProviderPlugin(
      JSON.stringify(
        manifest({
          providers: [
            {
              id: 'x',
              name: 'X',
              kind: 'openai',
              baseUrl: 'https://elsewhere.example.com/v1',
              regions: [
                { id: 'global', baseUrl: 'https://a.example.com/v1' },
                { id: 'cn', baseUrl: 'https://b.example.cn/v1' },
              ],
            },
          ],
        }),
      ),
    )
    let thrown: unknown
    try {
      providerPluginInfo(parsed)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderPluginError)
    expect(thrown).toMatchObject({
      code: ProviderPluginErrorCode.Invalid,
      path: 'providers.x.baseUrl',
    })
  })
})
