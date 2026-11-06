import { describe, expect, it, vi } from 'vitest'
import { applyTheme, resolveTheme } from './theme.js'

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  const media = {
    matches,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  }
  return {
    media,
    listeners,
    set(next: boolean) {
      media.matches = next
      for (const l of listeners) l()
    },
  }
}

describe('resolveTheme', () => {
  it('uses the system preference only for system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('writes an explicit theme without listening to the system', () => {
    const root = { setAttribute: vi.fn() }
    const matchMedia = vi.fn()
    const onResolved = vi.fn()
    applyTheme('dark', { root, matchMedia }, onResolved)()
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
    expect(matchMedia).not.toHaveBeenCalled()
    expect(onResolved).toHaveBeenCalledWith('dark')
  })

  it('follows system changes until disposed', () => {
    const root = { setAttribute: vi.fn() }
    const fake = fakeMedia(false)
    const dispose = applyTheme('system', {
      root,
      matchMedia: () => fake.media as unknown as MediaQueryList,
    })
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'light')
    fake.set(true)
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'dark')
    dispose()
    expect(fake.listeners.size).toBe(0)
  })

  it('treats system as light without matchMedia', () => {
    const root = { setAttribute: vi.fn() }
    applyTheme('system', { root })()
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'light')
  })
})
