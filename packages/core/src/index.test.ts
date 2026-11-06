import { EVENT_SCHEMA_VERSION } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_EVENT_SCHEMA_VERSION } from './index.js'

describe('workspace 链接', () => {
  it('core 能引用 protocol', () => {
    expect(SUPPORTED_EVENT_SCHEMA_VERSION).toBe(EVENT_SCHEMA_VERSION)
  })
})
