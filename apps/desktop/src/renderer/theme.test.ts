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
  it('maps system and the legacy values onto the four palettes', () => {
    expect(resolveTheme('system', true)).toBe('slate')
    expect(resolveTheme('system', false)).toBe('paper')
    expect(resolveTheme('light', true)).toBe('tundra')
    expect(resolveTheme('dark', false)).toBe('obsidian')
    expect(resolveTheme('graphite', false)).toBe('obsidian')
    expect(resolveTheme('obsidian', false)).toBe('obsidian')
    expect(resolveTheme('paper', true)).toBe('paper')
    expect(resolveTheme('slate', false)).toBe('slate')
  })
})

describe('applyTheme', () => {
  it('writes an explicit theme without listening to the system', () => {
    const root = { setAttribute: vi.fn() }
    const matchMedia = vi.fn()
    const onResolved = vi.fn()
    applyTheme('obsidian', { root, matchMedia }, onResolved)()
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'obsidian')
    expect(matchMedia).not.toHaveBeenCalled()
    expect(onResolved).toHaveBeenCalledWith('obsidian', true)
  })

  it('follows system changes until disposed', () => {
    const root = { setAttribute: vi.fn() }
    const fake = fakeMedia(false)
    const dispose = applyTheme('system', {
      root,
      matchMedia: () => fake.media as unknown as MediaQueryList,
    })
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'paper')
    fake.set(true)
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'slate')
    dispose()
    expect(fake.listeners.size).toBe(0)
  })

  it('treats system as the light paper palette without matchMedia', () => {
    const root = { setAttribute: vi.fn() }
    applyTheme('system', { root })()
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'paper')
  })
})
