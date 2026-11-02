import { describe, expect, it, vi } from 'vitest'
import {
  checkRendererProbe,
  isSmokeRun,
  runSmokeChecks,
  SMOKE_RESULT_PREFIX,
  type RendererProbe,
  type SmokeDeps,
} from './smoke.js'

const goodProbe: RendererProbe = {
  text: 'NEXUS-OS',
  nodeGlobals: [],
  api: { on: 'function', ready: 'function', request: 'function' },
  csp: "default-src 'self'; script-src 'self'",
  evalBlocked: true,
  ipcError: null,
}

function deps(overrides: Partial<SmokeDeps> = {}) {
  const report = vi.fn<(line: string) => void>()
  const exit = vi.fn<(code: number) => void>()
  const all: SmokeDeps = {
    waitForLoad: () => Promise.resolve(),
    probeRenderer: () => Promise.resolve(goodProbe),
    startHost: () => Promise.resolve(),
    expectedText: 'NEXUS-OS',
    userData: '/data',
    report,
    exit,
    timeoutMs: 50,
    ...overrides,
  }
  return { all, report, exit }
}

function reported(report: ReturnType<typeof vi.fn>): unknown {
  const line = report.mock.calls[0]?.[0] as string
  expect(line.startsWith(SMOKE_RESULT_PREFIX)).toBe(true)
  return JSON.parse(line.slice(SMOKE_RESULT_PREFIX.length))
}

describe('isSmokeRun', () => {
  it('is enabled only by NEXUS_SMOKE=1', () => {
    expect(isSmokeRun({ NEXUS_SMOKE: '1' })).toBe(true)
    expect(isSmokeRun({ NEXUS_SMOKE: '0' })).toBe(false)
    expect(isSmokeRun({})).toBe(false)
  })
})

describe('checkRendererProbe', () => {
  it('accepts an isolated renderer', () => {
    expect(checkRendererProbe(goodProbe, 'NEXUS-OS')).toEqual([])
  })

  it('reports Node globals, unexpected API and missing CSP', () => {
    const problems = checkRendererProbe(
      {
        text: 'NEXUS-OS',
        nodeGlobals: ['require', 'process'],
        api: { on: 'function', ready: 'function', request: 'function', send: 'function' },
        csp: null,
        evalBlocked: false,
        ipcError: 'rpc.timeout',
      },
      'NEXUS-OS',
    )
    expect(problems).toEqual([
      'renderer has Node globals: require, process',
      'unexpected preload API: {"on":"function","ready":"function","request":"function","send":"function"}',
      'renderer has no CSP',
      'CSP does not block eval',
      'session.list over IPC failed: rpc.timeout',
    ])
    expect(checkRendererProbe({ ...goodProbe, api: null }, 'NEXUS-OS')).toEqual([
      'unexpected preload API: null',
    ])
  })
})

describe('runSmokeChecks', () => {
  it('reports success and exits 0', async () => {
    const { all, report, exit } = deps()
    const result = await runSmokeChecks(all)
    expect(result).toEqual({
      ok: true,
      renderer: goodProbe,
      hostStarted: true,
      userData: '/data',
    })
    expect(reported(report)).toEqual(result)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('fails when the renderer does not show the app name', async () => {
    const probe = { ...goodProbe, text: null }
    const { all, exit } = deps({ probeRenderer: () => Promise.resolve(probe) })
    const result = await runSmokeChecks(all)
    expect(result).toMatchObject({ ok: false, hostStarted: false, renderer: probe })
    expect(result.error).toContain('renderer did not show')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails when the agent host does not start in time', async () => {
    const { all, report, exit } = deps({ startHost: () => new Promise(() => {}) })
    const result = await runSmokeChecks(all)
    expect(result.error).toBe('agent host start timed out after 50 ms')
    expect(reported(report)).toMatchObject({ ok: false, hostStarted: false })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('reports rejected steps, including non-Error values', async () => {
    const { all } = deps({ waitForLoad: () => Promise.reject(new Error('load failed')) })
    expect((await runSmokeChecks(all)).error).toBe('load failed')

    const { all: other } = deps({ startHost: () => Promise.reject('exited with code 3') })
    expect((await runSmokeChecks(other)).error).toBe('exited with code 3')

    const { all: sync } = deps({
      waitForLoad: () => {
        throw 'not ready'
      },
    })
    expect((await runSmokeChecks(sync)).error).toBe('not ready')
  })

  it('uses the default timeout when none is given', async () => {
    const { all } = deps()
    const { timeoutMs: _omit, ...rest } = all
    expect((await runSmokeChecks(rest)).ok).toBe(true)
  })
})
