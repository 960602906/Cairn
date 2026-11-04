import type { AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { PiErrorCode, httpStatusOf, toFailure } from './errors.js'

const failed = (errorMessage?: string): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider: 'p',
  model: 'm',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'error',
  ...(errorMessage !== undefined ? { errorMessage } : {}),
  timestamp: 0,
})

describe('httpStatusOf', () => {
  it('取文本中的 4xx / 5xx 状态码', () => {
    expect(httpStatusOf('401 Incorrect API key provided')).toBe(401)
    expect(httpStatusOf('Error (503): upstream')).toBe(503)
    expect(httpStatusOf('429: {"error":"slow down"}')).toBe(429)
  })

  it('不把更长的数字或小数当作状态码', () => {
    expect(httpStatusOf('took 4001 ms')).toBeUndefined()
    expect(httpStatusOf('version 1.404')).toBeUndefined()
    expect(httpStatusOf('fetch failed')).toBeUndefined()
  })
})

describe('toFailure', () => {
  it('按状态码归类', () => {
    expect(toFailure(failed('403 forbidden'))).toEqual({
      error: { code: PiErrorCode.AuthFailed, params: { status: 403 } },
      retryable: false,
    })
    expect(toFailure(failed('502 Bad Gateway'))).toEqual({
      error: { code: PiErrorCode.ServerError, params: { status: 502 } },
      retryable: true,
    })
    expect(toFailure(failed('404 model not found'))).toMatchObject({
      error: { code: PiErrorCode.BadRequest, params: { status: 404 } },
    })
  })

  it('上下文超限', () => {
    expect(
      toFailure(failed("This model's maximum context length is 8192 tokens"), 8192),
    ).toMatchObject({ error: { code: PiErrorCode.ContextOverflow }, retryable: false })
  })

  it('没有状态码：pi 判为临时错误时是网络错误，否则未知', () => {
    expect(toFailure(failed('fetch failed: ECONNREFUSED'))).toEqual({
      error: { code: PiErrorCode.NetworkError },
      retryable: true,
    })
    expect(toFailure(failed('something odd'))).toEqual({
      error: { code: PiErrorCode.Unknown },
      retryable: false,
    })
    expect(toFailure(failed())).toEqual({ error: { code: PiErrorCode.Unknown }, retryable: false })
  })
})
