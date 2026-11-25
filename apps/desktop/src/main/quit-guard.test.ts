import { describe, expect, it } from 'vitest'
import { createQuitGuard } from './quit-guard.js'

describe('createQuitGuard', () => {
  it('allows creating windows before quitting', () => {
    const guard = createQuitGuard()

    expect(guard.isQuitting()).toBe(false)
    expect(guard.canCreateWindow()).toBe(true)
  })

  it('reopens a window on activate only when none is open', () => {
    const guard = createQuitGuard()

    expect(guard.shouldCreateOnActivate(0)).toBe(true)
    expect(guard.shouldCreateOnActivate(1)).toBe(false)
  })

  it('refuses to create windows once quitting has begun (macOS activate during shutdown)', () => {
    const guard = createQuitGuard()

    guard.begin()

    expect(guard.isQuitting()).toBe(true)
    expect(guard.canCreateWindow()).toBe(false)
    expect(guard.shouldCreateOnActivate(0)).toBe(false)
  })

  it('stays quitting when before-quit fires again', () => {
    const guard = createQuitGuard()

    guard.begin()
    guard.begin()

    expect(guard.isQuitting()).toBe(true)
    expect(guard.shouldCreateOnActivate(0)).toBe(false)
  })

  it('keeps separate state per guard', () => {
    const quitting = createQuitGuard()
    const fresh = createQuitGuard()

    quitting.begin()

    expect(fresh.canCreateWindow()).toBe(true)
  })
})
