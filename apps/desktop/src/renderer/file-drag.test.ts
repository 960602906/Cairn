import { describe, expect, it, vi } from 'vitest'
import type { DragEvent } from 'react'
import { draggedFile, FILE_DRAG_TYPE, fileDragProps } from './file-drag.js'

const dragEvent = (data: string): DragEvent =>
  ({
    dataTransfer: {
      getData: (type: string) => (type === FILE_DRAG_TYPE ? data : ''),
      setData: vi.fn(),
      effectAllowed: 'none',
    },
  }) as unknown as DragEvent

describe('file drag', () => {
  it('puts the path and kind on the drag data', () => {
    const event = dragEvent('')
    const props = fileDragProps('docs/a.md', 'dir')
    expect(props.draggable).toBe(true)
    props.onDragStart(event)
    expect(event.dataTransfer.setData).toHaveBeenCalledWith(
      FILE_DRAG_TYPE,
      JSON.stringify({ path: 'docs/a.md', kind: 'dir' }),
    )
    expect(event.dataTransfer.effectAllowed).toBe('copy')
  })

  it('reads back a valid dragged file only', () => {
    expect(draggedFile(dragEvent(JSON.stringify({ path: 'a.ts', kind: 'file' })))).toEqual({
      path: 'a.ts',
      kind: 'file',
    })
    expect(draggedFile(dragEvent(''))).toBeUndefined()
    expect(draggedFile(dragEvent('{'))).toBeUndefined()
    expect(draggedFile(dragEvent(JSON.stringify({ path: '', kind: 'file' })))).toBeUndefined()
    expect(draggedFile(dragEvent(JSON.stringify({ path: 'a.ts', kind: 'image' })))).toBeUndefined()
    expect(draggedFile(dragEvent(JSON.stringify({ kind: 'file' })))).toBeUndefined()
  })
})
