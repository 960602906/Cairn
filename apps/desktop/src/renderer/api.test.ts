import { describe, expect, it } from 'vitest'
import type { RpcBridge } from '@cairn/protocol'
import { getMainApi } from './api.js'

describe('getMainApi', () => {
  it('wraps window.cairn into a typed client', async () => {
    const bridge: RpcBridge = {
      ready: () => Promise.resolve({ ok: true, result: undefined }),
      request: (method) => Promise.resolve({ ok: true, result: { method } }),
      on: () => () => undefined,
    }
    const api = getMainApi({ cairn: bridge })
    await expect(api?.request('session.list', {})).resolves.toEqual({ method: 'session.list' })
  })

  it('returns undefined without the preload API', () => {
    expect(getMainApi({})).toBeUndefined()
  })
})
