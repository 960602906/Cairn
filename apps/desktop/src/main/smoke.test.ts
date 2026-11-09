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
  text: 'Cairn',
  nodeGlobals: [],
  api: { on: 'function', ready: 'function', request: 'function', windowControls: 'object' },
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
    runTurn: () => Promise.resolve(),
    checkCredentials: () => Promise.resolve('stored'),
    credentialsRequired: true,
    checkSearch: () => Promise.resolve('ripgrep 15.0.0'),
    checkNative: () => Promise.resolve('job-object'),
    checkSkills: () => Promise.resolve(['example']),
    expectedText: 'Cairn',
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
  it('is enabled only by CAIRN_SMOKE=1', () => {
    expect(isSmokeRun({ CAIRN_SMOKE: '1' })).toBe(true)
    expect(isSmokeRun({ CAIRN_SMOKE: '0' })).toBe(false)
    expect(isSmokeRun({})).toBe(false)
  })
})

describe('checkRendererProbe', () => {
  it('accepts an isolated renderer', () => {
    expect(checkRendererProbe(goodProbe, 'Cairn')).toEqual([])
  })

  it('reports Node globals, unexpected API and missing CSP', () => {
    const problems = checkRendererProbe(
      {
        text: 'Cairn',
        nodeGlobals: ['require', 'process'],
        api: { on: 'function', ready: 'function', request: 'function', send: 'function' },
        csp: null,
        evalBlocked: false,
        ipcError: 'rpc.timeout',
      },
      'Cairn',
    )
    expect(problems).toEqual([
      'renderer has Node globals: require, process',
      'unexpected preload API: {"on":"function","ready":"function","request":"function","send":"function"}',
      'renderer has no CSP',
      'CSP does not block eval',
      'session.list over IPC failed: rpc.timeout',
    ])
    expect(checkRendererProbe({ ...goodProbe, api: null }, 'Cairn')).toEqual([
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
      turnCompleted: true,
      credentials: 'stored',
      search: 'ripgrep 15.0.0',
      native: 'job-object',
      skills: ['example'],
      userData: '/data',
    })
    expect(reported(report)).toEqual(result)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('fails when the renderer does not show the app name', async () => {
    const probe = { ...goodProbe, text: null }
    const { all, exit } = deps({ probeRenderer: () => Promise.resolve(probe) })
    const result = await runSmokeChecks(all)
    expect(result).toMatchObject({ ok: false, turnCompleted: false, renderer: probe })
    expect(result.error).toContain('renderer did not show')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails when the agent host does not start in time', async () => {
    const { all, report, exit } = deps({ runTurn: () => new Promise(() => {}) })
    const result = await runSmokeChecks(all)
    expect(result.error).toBe('conversation turn timed out after 50 ms')
    expect(reported(report)).toMatchObject({ ok: false, turnCompleted: false })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('reports rejected steps, including non-Error values', async () => {
    const { all } = deps({ waitForLoad: () => Promise.reject(new Error('load failed')) })
    expect((await runSmokeChecks(all)).error).toBe('load failed')

    const { all: other } = deps({ runTurn: () => Promise.reject('exited with code 3') })
    expect((await runSmokeChecks(other)).error).toBe('exited with code 3')

    const { all: sync } = deps({
      waitForLoad: () => {
        throw 'not ready'
      },
    })
    expect((await runSmokeChecks(sync)).error).toBe('not ready')
  })

  it('requires system encryption only where it must be available', async () => {
    const unavailable = () => Promise.resolve('unavailable' as const)
    const { all } = deps({ checkCredentials: unavailable })
    expect(await runSmokeChecks(all)).toMatchObject({
      ok: false,
      credentials: 'unavailable',
      error: 'system encryption (safeStorage) is unavailable',
    })
    const { all: linux } = deps({ checkCredentials: unavailable, credentialsRequired: false })
    expect(await runSmokeChecks(linux)).toMatchObject({ ok: true, credentials: 'unavailable' })

    const { all: broken } = deps({
      checkCredentials: () => Promise.reject(new Error('resolved a different key')),
    })
    expect(await runSmokeChecks(broken)).toMatchObject({
      ok: false,
      credentials: null,
      error: 'resolved a different key',
    })
  })

  it('fails when the bundled ripgrep cannot run', async () => {
    const { all } = deps({ checkSearch: () => Promise.reject(new Error('spawn rg ENOENT')) })
    expect(await runSmokeChecks(all)).toMatchObject({
      ok: false,
      credentials: 'stored',
      search: null,
      native: null,
      skills: null,
      error: 'spawn rg ENOENT',
    })
  })

  it('fails when koffi or a bundled skill cannot be loaded', async () => {
    const { all } = deps({ checkNative: () => Promise.reject(new Error('no koffi binary')) })
    expect(await runSmokeChecks(all)).toMatchObject({
      ok: false,
      search: 'ripgrep 15.0.0',
      native: null,
      error: 'no koffi binary',
    })

    const { all: missingSkill } = deps({
      checkSkills: () => Promise.reject(new Error('built-in skill example not found')),
    })
    expect(await runSmokeChecks(missingSkill)).toMatchObject({
      ok: false,
      native: 'job-object',
      skills: null,
      error: 'built-in skill example not found',
    })
  })

  it('uses the default timeout when none is given', async () => {
    const { all } = deps()
    const { timeoutMs: _omit, ...rest } = all
    expect((await runSmokeChecks(rest)).ok).toBe(true)
  })
})
