/**
 * 把文件树、改动面板里的文件拖进输入框：拖的是路径，放下时等同于插入一个 `@` 引用。
 *
 * 用自定义 MIME 类型，只在同一个界面里生效；外面拖进来的文件或文字不处理（图片上传不在这次范围内）。
 */
import type { DragEvent } from 'react'

export const FILE_DRAG_TYPE = 'application/x-cairn-path'

export interface DraggedFile {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/** 让一个文件行可以被拖拽。 */
export function fileDragProps(path: string, kind: DraggedFile['kind']) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(FILE_DRAG_TYPE, JSON.stringify({ path, kind }))
      event.dataTransfer.effectAllowed = 'copy'
    },
  }
}

/** 拖进输入框的内容是不是一个文件；不是时返回 undefined。 */
export function draggedFile(event: DragEvent): DraggedFile | undefined {
  const raw = event.dataTransfer.getData(FILE_DRAG_TYPE)
  if (raw === '') return undefined
  try {
    const value = JSON.parse(raw) as { path?: unknown; kind?: unknown }
    if (typeof value.path !== 'string' || value.path === '') return undefined
    if (value.kind !== 'file' && value.kind !== 'dir') return undefined
    return { path: value.path, kind: value.kind }
  } catch {
    return undefined
  }
}
