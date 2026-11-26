import { describe, expect, it } from 'vitest'
import {
  clampZoomLevel,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  nextZoomLevel,
  zoomActionFor,
  type ZoomInput,
} from './window-zoom.js'

const input = (init: Partial<ZoomInput>): ZoomInput => ({
  type: 'keyDown',
  key: '=',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...init,
})

describe('zoomActionFor', () => {
  it('uses ⌘ on macOS and Ctrl elsewhere', () => {
    expect(zoomActionFor(input({ meta: true }), 'darwin')).toBe('in')
    expect(zoomActionFor(input({ meta: true, key: '-' }), 'darwin')).toBe('out')
    expect(zoomActionFor(input({ meta: true, key: '0' }), 'darwin')).toBe('reset')
    expect(zoomActionFor(input({ control: true }), 'win32')).toBe('in')
    expect(zoomActionFor(input({ control: true, key: '-' }), 'linux')).toBe('out')
    expect(zoomActionFor(input({ control: true, key: '0' }), 'linux')).toBe('reset')
  })

  it('ignores the wrong modifier, Alt combinations and non-keydown events', () => {
    expect(zoomActionFor(input({ control: true }), 'darwin')).toBeUndefined()
    expect(zoomActionFor(input({ meta: true }), 'win32')).toBeUndefined()
    expect(zoomActionFor(input({ control: true, alt: true }), 'win32')).toBeUndefined()
    expect(zoomActionFor(input({ control: true, type: 'keyUp' }), 'win32')).toBeUndefined()
    expect(zoomActionFor(input({ control: true, key: 'k' }), 'win32')).toBeUndefined()
  })

  it('accepts + as well as = (Shift+=)', () => {
    expect(zoomActionFor(input({ control: true, key: '+', shift: true }), 'win32')).toBe('in')
  })
})

describe('zoom levels', () => {
  it('clamps and steps by half a level', () => {
    expect(clampZoomLevel(undefined)).toBe(0)
    expect(clampZoomLevel(Number.NaN)).toBe(0)
    expect(clampZoomLevel(0.26)).toBe(0.5)
    expect(clampZoomLevel(99)).toBe(MAX_ZOOM_LEVEL)
    expect(clampZoomLevel(-99)).toBe(MIN_ZOOM_LEVEL)
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0, 'out')).toBe(-0.5)
    expect(nextZoomLevel(2.5, 'in')).toBe(3)
    expect(nextZoomLevel(MAX_ZOOM_LEVEL, 'in')).toBe(MAX_ZOOM_LEVEL)
    expect(nextZoomLevel(-2, 'out')).toBe(-2.5)
    expect(nextZoomLevel(2, 'reset')).toBe(0)
  })
})
