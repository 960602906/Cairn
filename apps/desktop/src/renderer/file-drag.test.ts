// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ClipboardEvent, DragEvent } from 'react'
import {
  draggedFile,
  externalDroppedFiles,
  FILE_DRAG_TYPE,
  fileDragProps,
  filePathFor,
  fileUrisToPaths,
  pastedFilePaths,
  relativeMentionPath,
} from './file-drag.js'

const file = (path: string): File => ({ path }) as unknown as File

const dragEvent = (data: string): DragEvent =>
  ({
    dataTransfer: {
      getData: (type: string) => (type === FILE_DRAG_TYPE ? data : ''),
      setData: vi.fn(),
      effectAllowed: 'none',
    },
  }) as unknown as DragEvent

function externalEvent(dataTransfer: unknown): DragEvent {
  return { dataTransfer } as unknown as DragEvent
}

function item(kind: string, path: string, directory = false) {
  return {
    kind,
    getAsFile: () => file(path),
    ...(directory
      ? { webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }) }
      : { webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) }),
  }
}

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

describe('filePathFor', () => {
  it('prefers the injected resolver and drops empty results', () => {
    const fromFile = (f: File) => (f as unknown as { path: string }).path
    expect(filePathFor(file('/work/a.md'), fromFile)).toBe('/work/a.md')
    expect(filePathFor(file(''), fromFile)).toBeUndefined()
  })

  it('falls back to the legacy File.path field on older Electron', () => {
    expect(filePathFor(file('/legacy/a.md'), undefined)).toBe('/legacy/a.md')
    expect(filePathFor({} as File, undefined)).toBeUndefined()
  })
})

describe('externalDroppedFiles', () => {
  it('maps dropped files and directories to paths', () => {
    const fromFile = (f: File) => (f as unknown as { path: string }).path
    const event = externalEvent({
      items: [item('file', '/work/docs/a.md'), item('file', '/work/src', true)],
      files: [],
      getData: () => '',
    })
    expect(externalDroppedFiles(event, fromFile)).toEqual([
      { path: '/work/docs/a.md', kind: 'file' },
      { path: '/work/src', kind: 'dir' },
    ])
  })

  it('falls back to files and skips paths it cannot resolve', () => {
    const fromFile = (_f: File) => ''
    const event = externalEvent({
      items: [],
      files: [file('/work/a.md'), file('')],
      getData: () => '',
    })
    expect(externalDroppedFiles(event, fromFile)).toEqual([])
  })

  it('ignores non-file and empty items, then falls back to the files list', () => {
    const fromFile = (f: File) => (f as unknown as { path: string }).path
    const event = externalEvent({
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => null },
        { kind: 'file', getAsFile: () => file('/work/b.md') },
        { kind: 'file', getAsFile: () => file('') },
      ],
      files: [],
    })
    expect(externalDroppedFiles(event, fromFile)).toEqual([{ path: '/work/b.md', kind: 'file' }])

    // items 缺失时只看 files；两个都缺失时为空。
    expect(externalDroppedFiles(externalEvent({ files: [file('/work/c.md')] }), fromFile)).toEqual([
      { path: '/work/c.md', kind: 'file' },
    ])
    expect(externalDroppedFiles(externalEvent({}), fromFile)).toEqual([])
  })
})

describe('pastedFilePaths', () => {
  it('uses file objects first, then falls back to a file:// URI list', () => {
    const fromFile = (_f: File) => ''
    const event = {
      clipboardData: {
        files: [],
        getData: () => 'file:///work/a.md\n# comment\nfile:///C:/repo/src/',
      },
    } as unknown as ClipboardEvent
    expect(pastedFilePaths(event, fromFile)).toEqual([
      { path: '/work/a.md', kind: 'file' },
      { path: 'C:/repo/src/', kind: 'dir' },
    ])

    // GNOME 文件管理器的自定义 MIME。
    const gnome = {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === 'x-special/gnome-copied-files' ? 'copy\nfile:///work/a.md' : '',
      },
    } as unknown as ClipboardEvent
    expect(pastedFilePaths(gnome, fromFile)).toEqual([{ path: '/work/a.md', kind: 'file' }])
  })

  it('uses clipboard file objects first, including directories, and skips missing data', () => {
    const fromFile = (f: File) => (f as unknown as { path: string }).path
    const direct = {
      clipboardData: { files: [file('/work/a.md'), file('/work/src/')] },
    } as unknown as ClipboardEvent
    expect(pastedFilePaths(direct, fromFile)).toEqual([
      { path: '/work/a.md', kind: 'file' },
      { path: '/work/src/', kind: 'dir' },
    ])

    const itemsOnly = {
      clipboardData: {
        files: [],
        items: [
          { kind: 'string', getAsFile: () => null },
          { kind: 'file', getAsFile: () => null },
          item('file', '/work/docs', true),
        ],
        getData: () => '',
      },
    } as unknown as ClipboardEvent
    expect(pastedFilePaths(itemsOnly, fromFile)).toEqual([{ path: '/work/docs', kind: 'dir' }])

    expect(pastedFilePaths({} as ClipboardEvent, fromFile)).toEqual([])
    const noGetData = {
      clipboardData: { files: [], items: [], getData: undefined },
    } as unknown as ClipboardEvent
    expect(pastedFilePaths(noGetData, fromFile)).toEqual([])
  })
})

describe('fileUrisToPaths', () => {
  it('decodes, strips Windows drive prefixes, and ignores non-file URIs', () => {
    expect(fileUrisToPaths('file:///work/a%20b.md')).toEqual([
      { path: '/work/a b.md', kind: 'file' },
    ])
    expect(fileUrisToPaths('file:///C:/repo/src/')).toEqual([{ path: 'C:/repo/src/', kind: 'dir' }])
    expect(fileUrisToPaths('https://example.com/a.md\n')).toEqual([])
  })

  it('handles localhost, empty URIs, and malformed percent escapes', () => {
    expect(fileUrisToPaths('file://localhost/work/a.md')).toEqual([
      { path: '/work/a.md', kind: 'file' },
    ])
    expect(fileUrisToPaths('file://\n\n')).toEqual([])
    expect(fileUrisToPaths('file:///work/%E0%A4%A.md')).toEqual([
      { path: '/work/%E0%A4%A.md', kind: 'file' },
    ])
  })
})

describe('relativeMentionPath', () => {
  it('keeps paths inside the workspace and rejects outside or the root itself', () => {
    expect(relativeMentionPath('/work', '/work/docs/a.md')).toBe('docs/a.md')
    expect(relativeMentionPath('/work', '/work')).toBeUndefined()
    expect(relativeMentionPath('/work', '/work2/a.md')).toBeUndefined()
    expect(relativeMentionPath('/work/', '/work/docs/a.md')).toBe('docs/a.md')
    expect(relativeMentionPath('', '/work/a.md')).toBeUndefined()
  })

  it('compares case-insensitively on Windows and returns forward slashes', () => {
    expect(relativeMentionPath('C:\\work', 'c:\\work\\src\\a.ts', 'win32')).toBe('src/a.ts')
    expect(relativeMentionPath('C:\\work', 'D:\\work\\a.ts', 'win32')).toBeUndefined()
  })
})
