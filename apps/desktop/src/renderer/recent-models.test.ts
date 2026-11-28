// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelChoice } from './model-labels.js'
import {
  RECENT_MODELS_KEY,
  readRecentModels,
  rememberRecentModel,
  resolveRecentChoices,
  writeRecentModels,
} from './recent-models.js'

afterEach(() => {
  window.localStorage.clear()
})

const fast = { providerId: 'p1', modelId: 'fast' }
const strong = { providerId: 'p2', modelId: 'strong' }

const choice = (ref: { providerId: string; modelId: string }, name = ref.modelId): ModelChoice => ({
  ref,
  provider: ref.providerId,
  kind: 'openai',
  name,
  contextWindow: 100_000,
  supportsTools: true,
  supportsReasoning: false,
})

describe('recent models', () => {
  it('reads, writes, and remembers models in localStorage', () => {
    expect(readRecentModels()).toEqual([])
    writeRecentModels([fast, strong])
    expect(readRecentModels()).toEqual([fast, strong])
    expect(JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) ?? '[]')).toEqual([
      fast,
      strong,
    ])

    expect(rememberRecentModel(strong)).toEqual([strong, fast])
    expect(rememberRecentModel(fast)).toEqual([fast, strong])
  })

  it('ignores corrupt storage and deduplicates', () => {
    window.localStorage.setItem(RECENT_MODELS_KEY, '{not json')
    expect(readRecentModels()).toEqual([])

    window.localStorage.setItem(
      RECENT_MODELS_KEY,
      JSON.stringify([
        null,
        'x',
        { providerId: '', modelId: 'a' },
        { providerId: 'a', modelId: '' },
        fast,
        { providerId: 'p1', modelId: 'fast' },
        { bad: true },
        strong,
      ]),
    )
    expect(readRecentModels()).toEqual([fast, strong])

    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify({ not: 'array' }))
    expect(readRecentModels()).toEqual([])
  })

  it('caps the recent list at five entries', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      providerId: 'p',
      modelId: `m${i}`,
    }))
    writeRecentModels(many)
    expect(readRecentModels()).toHaveLength(5)
    expect(readRecentModels()[0]).toEqual(many[0])

    const overflow = [...many.map((ref) => ref), { providerId: 'p', modelId: 'extra' }]
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(overflow))
    expect(readRecentModels()).toHaveLength(5)
  })

  it('survives a storage write failure', () => {
    const original = window.localStorage.setItem.bind(window.localStorage)
    window.localStorage.setItem = () => {
      throw new Error('quota')
    }
    expect(() => writeRecentModels([fast])).not.toThrow()
    window.localStorage.setItem = original
  })

  it('intersects recent refs with enabled choices in recent order', () => {
    expect(resolveRecentChoices([choice(fast), choice(strong, '强')], [strong, fast])).toEqual([
      choice(strong, '强'),
      choice(fast),
    ])
    expect(resolveRecentChoices([choice(fast)], [strong, fast])).toEqual([choice(fast)])
    expect(resolveRecentChoices([choice(fast)], [])).toEqual([])
  })
})
