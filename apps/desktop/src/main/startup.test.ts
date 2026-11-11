import { describe, expect, it, vi } from 'vitest'
import { configureElectronRuntime } from './electron-runtime.js'

describe('configureElectronRuntime', () => {
  it('disables GPU in non-accelerated environments', () => {
    const appendSwitch = vi.fn()

    configureElectronRuntime({ CAIRN_ENABLE_GPU: '0' }, { appendSwitch })

    expect(appendSwitch).toHaveBeenCalledWith('disable-gpu')
    expect(appendSwitch).toHaveBeenCalledWith('disable-software-rasterizer')
  })

  it('allows GPU override when explicitly enabled', () => {
    const appendSwitch = vi.fn()

    configureElectronRuntime({ CAIRN_ENABLE_GPU: '1' }, { appendSwitch })

    expect(appendSwitch).not.toHaveBeenCalled()
  })
})
