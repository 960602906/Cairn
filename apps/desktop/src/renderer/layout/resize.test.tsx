// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle, useResizableWidth, type ResizableOptions } from './resize.js'

const OPTIONS: ResizableOptions = {
  storageKey: 'test.width',
  initial: 300,
  min: 200,
  max: 400,
  edge: 'right',
}

function Probe(props: Partial<ResizableOptions>) {
  const { width, dragging, handleProps } = useResizableWidth({ ...OPTIONS, ...props })
  return (
    <div data-testid="box" data-dragging={dragging} style={{ width }}>
      <ResizeHandle label="调整宽度" {...handleProps} />
    </div>
  )
}

const width = () => screen.getByTestId('box').style.width
const handle = () => screen.getByRole('separator', { name: '调整宽度' })
const pointer = (type: string, clientX: number, button = 0) => {
  const event = new MouseEvent(type, { bubbles: true, clientX, button })
  return event
}

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('useResizableWidth', () => {
  it('starts from the default and restores a stored width within bounds', () => {
    const first = render(<Probe />)
    expect(width()).toBe('300px')
    expect(handle().getAttribute('aria-valuenow')).toBe('300')
    first.unmount()

    window.localStorage.setItem('test.width', '9999')
    const second = render(<Probe />)
    expect(width()).toBe('400px')
    second.unmount()

    window.localStorage.setItem('test.width', 'wide')
    render(<Probe />)
    expect(width()).toBe('300px')
  })

  it('drags from the right edge, clamps, and remembers the width', () => {
    render(<Probe />)
    fireEvent(handle(), pointer('pointerdown', 100))
    expect(screen.getByTestId('box').dataset['dragging']).toBe('true')
    fireEvent(window, pointer('pointermove', 140))
    expect(width()).toBe('340px')
    fireEvent(window, pointer('pointermove', 900))
    expect(width()).toBe('400px')
    fireEvent(window, pointer('pointerup', 900))
    expect(screen.getByTestId('box').dataset['dragging']).toBe('false')
    // 松手之后的移动不再生效。
    fireEvent(window, pointer('pointermove', 0))
    expect(width()).toBe('400px')
    expect(window.localStorage.getItem('test.width')).toBe('400')
  })

  it('grows towards the left when the handle sits on the left edge', () => {
    render(<Probe edge="left" />)
    fireEvent(handle(), pointer('pointerdown', 500))
    fireEvent(window, pointer('pointermove', 460))
    expect(width()).toBe('340px')
    fireEvent(window, pointer('pointercancel', 460))
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(width()).toBe('356px')
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(width()).toBe('340px')
  })

  it('ignores other buttons and keys, nudges with arrows, and resets on double click', () => {
    render(<Probe />)
    fireEvent(handle(), pointer('pointerdown', 100, 2))
    fireEvent(window, pointer('pointermove', 180))
    expect(width()).toBe('300px')
    fireEvent.keyDown(handle(), { key: 'Enter' })
    expect(width()).toBe('300px')
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(width()).toBe('316px')
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(width()).toBe('284px')
    fireEvent.doubleClick(handle())
    expect(width()).toBe('300px')
  })

  it('stops listening when unmounted mid-drag and survives a blocked storage', () => {
    const view = render(<Probe />)
    fireEvent(handle(), pointer('pointerdown', 100))
    const remove = vi.spyOn(window, 'removeEventListener')
    view.unmount()
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function))
    remove.mockRestore()

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      render(<Probe />)
      expect(width()).toBe('300px')
      fireEvent.keyDown(handle(), { key: 'ArrowRight' })
      expect(width()).toBe('316px')
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})
