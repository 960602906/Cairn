// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSettingsData,
  loadSettingsData,
  peekSettingsData,
  setSettingsData,
  useSettingsData,
} from './settings-data-cache.js'

beforeEach(clearSettingsData)

describe('settings-data-cache', () => {
  it('caches loaded values and shares one request per key', async () => {
    const loader = vi.fn(async () => [1])
    const [first, second] = await Promise.all([
      loadSettingsData('k', loader),
      loadSettingsData('k', loader),
    ])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(first).toEqual([1])
    expect(second).toEqual([1])
    expect(peekSettingsData('k')).toEqual([1])
  })

  it('keeps the previous value when a load fails', async () => {
    setSettingsData('k', 1)
    await expect(loadSettingsData('k', async () => undefined)).resolves.toBeUndefined()
    expect(peekSettingsData('k')).toBe(1)
    await expect(
      loadSettingsData('k', async () => {
        throw new Error('boom')
      }),
    ).resolves.toBeUndefined()
    expect(peekSettingsData('k')).toBe(1)
  })

  it('clears every cached value', () => {
    setSettingsData('k', 1)
    setSettingsData('k', undefined)
    expect(peekSettingsData('k')).toBeUndefined()
    setSettingsData('k', 2)
    clearSettingsData()
    expect(peekSettingsData('k')).toBeUndefined()
  })

  it('renders the cached value first and revalidates in the background', async () => {
    setSettingsData('k', 'old')
    const loader = vi.fn(async () => 'new')
    const { result } = renderHook(() => useSettingsData('k', loader))
    expect(result.current.value).toBe('old')
    await waitFor(() => expect(result.current.value).toBe('new'))
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('flags a failed reload but keeps the cached value', async () => {
    setSettingsData('k', 'old')
    const { result } = renderHook(() => useSettingsData('k', async () => undefined))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.value).toBe('old')
  })

  it('starts empty and waits for the first load', async () => {
    let resolve: (value: string) => void = () => {}
    const pendingValue = new Promise<string>((done) => {
      resolve = done
    })
    const { result } = renderHook(() => useSettingsData('k', () => pendingValue))
    expect(result.current.value).toBeUndefined()
    await act(async () => {
      resolve('done')
      await pendingValue
    })
    await waitFor(() => expect(result.current.value).toBe('done'))
  })

  it('switches to the cached value when the key changes', async () => {
    setSettingsData('a', 'A')
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useSettingsData(key, async () => peekSettingsData<string>(key) ?? 'fresh'),
      { initialProps: { key: 'b' } },
    )
    await waitFor(() => expect(result.current.value).toBe('fresh'))
    rerender({ key: 'a' })
    expect(result.current.value).toBe('A')
  })

  it('writes known values through set', async () => {
    const { result } = renderHook(() => useSettingsData('k', async () => 'loaded'))
    await waitFor(() => expect(result.current.value).toBe('loaded'))
    act(() => result.current.set('set'))
    expect(result.current.value).toBe('set')
    expect(peekSettingsData('k')).toBe('set')
  })
})
