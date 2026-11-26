import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowStateService,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  parseWindowState,
  restoreWindowState,
} from './window-state.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-window-state-'))
  file = join(dir, 'window-state.json')
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const display = { x: 0, y: 0, width: 1920, height: 1080 }

describe('parseWindowState', () => {
  it('uses defaults for missing or invalid fields', () => {
    expect(parseWindowState(undefined)).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
      zoomLevel: 0,
    })
    expect(
      parseWindowState({
        width: 'wide',
        height: 900,
        x: 10,
        y: Number.NaN,
        maximized: 'yes',
        zoomLevel: 99,
      }),
    ).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: 900,
      maximized: false,
      zoomLevel: 3,
    })
  })

  it('rounds sizes and keeps a valid position', () => {
    expect(parseWindowState({ width: 1000.4, height: 700.6, x: 20.2, y: 30.8 })).toEqual({
      width: 1000,
      height: 701,
      x: 20,
      y: 31,
      maximized: false,
      zoomLevel: 0,
    })
  })
})

describe('restoreWindowState', () => {
  it('keeps a visible position and clamps the size to the screens', () => {
    expect(
      restoreWindowState(
        { width: 5000, height: 100, x: 40, y: 50, maximized: true, zoomLevel: -1.5 },
        [display],
      ),
    ).toEqual({
      width: 1920,
      height: MIN_WINDOW_HEIGHT,
      x: 40,
      y: 50,
      maximized: true,
      zoomLevel: -1.5,
    })
  })

  it('drops a position that no longer lands on any screen', () => {
    expect(
      restoreWindowState(
        { width: 1000, height: 700, x: -5000, y: -5000, maximized: false, zoomLevel: 0 },
        [display],
      ),
    ).toEqual({ width: 1000, height: 700, maximized: false, zoomLevel: 0 })
  })

  it('keeps the default maximum when no screen is reported', () => {
    expect(
      restoreWindowState(
        { width: 2000, height: 1000, x: 10, y: 20, maximized: false, zoomLevel: 0 },
        [],
      ),
    ).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
      zoomLevel: 0,
    })
  })

  it('keeps a position with enough visible pixels and drops one below the limit', () => {
    const base = { width: 1000, height: 700, maximized: false, zoomLevel: 0 } as const
    expect(restoreWindowState({ ...base, x: 1840, y: 100 }, [display]).x).toBe(1840)
    expect(restoreWindowState({ ...base, x: 1841, y: 100 }, [display]).x).toBeUndefined()
    expect(restoreWindowState({ ...base, x: 100, y: 1000 }, [display]).y).toBe(1000)
    expect(restoreWindowState({ ...base, x: 100, y: 1001 }, [display]).y).toBeUndefined()
  })

  it('keeps the minimum size when every screen is smaller', () => {
    const small = { x: 0, y: 0, width: 500, height: 400 }
    expect(
      restoreWindowState({ width: 1000, height: 700, x: 0, y: 0, maximized: false, zoomLevel: 0 }, [
        small,
      ]),
    ).toEqual({
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
      x: 0,
      y: 0,
      maximized: false,
      zoomLevel: 0,
    })
  })
})

describe('createWindowStateService', () => {
  it('starts with defaults when the file does not exist', () => {
    const onError = vi.fn()
    const service = createWindowStateService({ file, onError })
    expect(service.get()).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
      zoomLevel: 0,
    })
    expect(onError).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('reads a saved state and reports a broken file', () => {
    writeFileSync(file, JSON.stringify({ width: 900, height: 600, maximized: true }))
    expect(createWindowStateService({ file }).get()).toMatchObject({
      width: 900,
      height: 600,
      maximized: true,
    })

    writeFileSync(file, '{oops')
    const onError = vi.fn()
    const service = createWindowStateService({ file, onError })
    expect(service.get().width).toBe(DEFAULT_WINDOW_WIDTH)
    expect(onError).toHaveBeenCalled()
  })

  it('reports read errors other than a missing file', () => {
    const onError = vi.fn()
    const service = createWindowStateService({ file: dir, onError })
    expect(service.get().width).toBe(DEFAULT_WINDOW_WIDTH)
    expect(onError).toHaveBeenCalled()
  })

  it('reports a failed write without throwing', () => {
    const onError = vi.fn()
    const service = createWindowStateService({
      file: join(dir, 'missing', 'window-state.json'),
      onError,
    })
    service.update({ width: 900, height: 600, maximized: false, zoomLevel: 0 })
    expect(() => service.flush()).not.toThrow()
    expect(onError).toHaveBeenCalled()
  })

  it('debounces writes and flushes immediately', () => {
    vi.useFakeTimers()
    const service = createWindowStateService({ file, delayMs: 400 })
    service.update({ width: 900, height: 600, x: 10, y: 20, maximized: false, zoomLevel: 0 })
    service.update({ width: 1000, height: 700, x: 30, y: 40, maximized: false, zoomLevel: 0.5 })
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(399)
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      width: 1000,
      height: 700,
      x: 30,
      y: 40,
      maximized: false,
      zoomLevel: 0.5,
    })

    service.update({ width: 1100, height: 800, maximized: true, zoomLevel: 1 })
    service.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      width: 1100,
      height: 800,
      maximized: true,
      zoomLevel: 1,
    })
  })

  it('does not rewrite an unchanged state', () => {
    const service = createWindowStateService({ file })
    service.update({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
      zoomLevel: 0,
    })
    service.flush()
    expect(existsSync(file)).toBe(false)
  })
})
