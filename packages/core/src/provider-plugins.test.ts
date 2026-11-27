import { describe, expect, it } from 'vitest'
import { ProviderTemplateSpec } from '@cairn/protocol'
import {
  parseProviderPlugin,
  ProviderPluginError,
  ProviderPluginErrorCode,
  providerPluginInfo,
  resolveAssetUrl,
  resolvePluginIcons,
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

describe('provider plugins (ADR-0050)', () => {
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

  it('resolves relative icons against the plugin file, like a browser', () => {
    const base = 'https://raw.example.com/repo/main/plugins/acme.json'
    expect(resolveAssetUrl('icons/acme.svg', base)).toBe(
      'https://raw.example.com/repo/main/plugins/icons/acme.svg',
    )
    expect(resolveAssetUrl('./a//b.png', `${base}?raw=1`)).toBe(
      'https://raw.example.com/repo/main/plugins/a/b.png',
    )
    expect(resolveAssetUrl('https://cdn.example.com/x.png', undefined)).toBe(
      'https://cdn.example.com/x.png',
    )
    expect(resolveAssetUrl('data:image/png;base64,AAAA', undefined)).toBe(
      'data:image/png;base64,AAAA',
    )
    expect(resolveAssetUrl('icons/a.png', undefined)).toBeUndefined()
    expect(resolveAssetUrl('icons/a.png', 'http://insecure.example.com/p.json')).toBeUndefined()
    expect(resolveAssetUrl('../escape.png', base)).toBeUndefined()
    expect(resolveAssetUrl('/root.png', base)).toBeUndefined()
    expect(resolveAssetUrl('.', base)).toBeUndefined()
  })

  it('keeps displayable icons and websites on plugins and templates', () => {
    const parsed = parseProviderPlugin(
      JSON.stringify(
        manifest({
          icon: 'icons/acme.svg',
          homepage: 'https://acme.example',
          providers: [
            {
              id: 'gateway',
              name: 'Acme Gateway',
              kind: 'openai',
              baseUrl: 'https://api.acme.example/v1',
              homepage: 'https://gateway.acme.example',
              icon: 'gateway.png',
            },
            {
              id: 'inline',
              name: 'Inline',
              kind: 'openai',
              baseUrl: 'https://inline.example/v1',
              icon: 'data:image/svg+xml;base64,PHN2Zy8+',
            },
          ],
        }),
      ),
    )
    // 本地文件：相对图标无法解析，不显示（回到网站图标）
    const local = providerPluginInfo(parsed)
    expect(local).not.toHaveProperty('icon')
    expect(local.templates[0]).toMatchObject({ homepage: 'https://gateway.acme.example' })
    expect(local.templates[0]).not.toHaveProperty('icon')
    expect(local.templates[1]!.icon).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    // 服务没有自己的网站时用插件的，用来找网站图标
    expect(local.templates[1]!.homepage).toBe('https://acme.example')

    const resolved = resolvePluginIcons(parsed, 'https://raw.example.com/r/main/plugins/acme.json')
    expect(resolved.icon).toBe('https://raw.example.com/r/main/plugins/icons/acme.svg')
    const info = providerPluginInfo(resolved)
    expect(info.icon).toBe('https://raw.example.com/r/main/plugins/icons/acme.svg')
    expect(info.templates[0]!.icon).toBe('https://raw.example.com/r/main/plugins/gateway.png')
    // 服务没有自己的图标时用插件的图标
    const shared = providerPluginInfo({
      ...resolved,
      providers: resolved.providers.map(({ icon: _icon, ...entry }) => entry),
    })
    expect(shared.templates.map((t) => t.icon)).toEqual([
      'https://raw.example.com/r/main/plugins/icons/acme.svg',
      'https://raw.example.com/r/main/plugins/icons/acme.svg',
    ])
    expect(ProviderTemplateSpec.safeParse(info.templates[0]).success).toBe(true)
    // 没有来源地址时去掉相对图标
    const dropped = resolvePluginIcons(parsed, undefined)
    expect(dropped).not.toHaveProperty('icon')
    expect(dropped.providers[0]).not.toHaveProperty('icon')
    expect(dropped.providers[1]!.icon).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it('rejects icons that are neither https, inline images nor relative paths', () => {
    for (const icon of [
      'http://x.example/a.png',
      'javascript:alert(1)',
      '../a.png',
      'data:text/html;base64,AA',
    ]) {
      expect(
        codeOf(() => parseProviderPlugin(JSON.stringify(manifest({ icon })))),
        icon,
      ).toBe(ProviderPluginErrorCode.Invalid)
    }
  })

  it('reads type, author and the claimed source without trusting the claim (ADR-0050)', () => {
    const parsed = parseProviderPlugin(
      JSON.stringify(manifest({ type: 'provider', author: 'Cairn', source: 'official' })),
    )
    expect(parsed).toMatchObject({ type: 'provider', author: 'Cairn', source: 'official' })
    // 实际来源由调用方给出，默认是本地文件
    expect(providerPluginInfo(parsed)).toMatchObject({ author: 'Cairn', origin: 'local' })
    expect(providerPluginInfo(parsed, 'official').origin).toBe('official')
    expect(providerPluginInfo(parseProviderPlugin(JSON.stringify(manifest())))).not.toHaveProperty(
      'author',
    )
    for (const type of ['theme', 'Provider', 3]) {
      expect(codeOf(() => parseProviderPlugin(JSON.stringify(manifest({ type }))))).toBe(
        ProviderPluginErrorCode.UnsupportedType,
      )
    }
  })
})
