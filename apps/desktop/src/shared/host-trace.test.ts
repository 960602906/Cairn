import { describe, expect, it } from 'vitest'
import { HOST_TRACE_ENV, hostEnvironment } from './host-trace.js'

describe('hostEnvironment', () => {
  const env = { PATH: '/bin', [HOST_TRACE_ENV]: '/tmp/trace.jsonl', EMPTY: undefined }

  it('未打包时原样传入（去掉未定义的项）', () => {
    expect(hostEnvironment(env, false)).toEqual({
      PATH: '/bin',
      [HOST_TRACE_ENV]: '/tmp/trace.jsonl',
    })
  })

  it('打包后去掉历史记录开关', () => {
    expect(hostEnvironment(env, true)).toEqual({ PATH: '/bin' })
  })
})
