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
      JSON.stringify([fast, { providerId: 'p1', modelId: 'fast' }, { bad: true }, strong]),
    )
    expect(readRecentModels()).toEqual([fast, strong])
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
