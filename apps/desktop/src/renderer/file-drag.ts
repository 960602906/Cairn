/**
 * 把文件树、改动面板里的文件拖进输入框：拖的是路径，放下时等同于插入一个 `@` 引用。
 *
 * 应用内拖动走自定义 MIME 类型；操作系统（Finder / 资源管理器）拖入或粘贴的文件走
 * Electron `webUtils.getPathForFile` 解析出的磁盘路径，再转成工作空间相对路径。
 */
import type { ClipboardEvent, DragEvent } from 'react'

export const FILE_DRAG_TYPE = 'application/x-cairn-path'

export interface DraggedFile {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/** 外部（操作系统）拖入 / 粘贴的文件。 */
export interface ExternalFile {
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

/** 用 `webUtils.getPathForFile`（或旧的 `File.path`）拿到文件的磁盘路径；拿不到时为 undefined。 */
export function filePathFor(
  file: File,
  fromFile: ((file: File) => string) | undefined,
): string | undefined {
  const path = fromFile ? fromFile(file) : (file as File & { path?: string }).path
  return path === undefined || path === '' ? undefined : path
}

function entryKind(entry: FileSystemEntry | null | undefined): 'file' | 'dir' {
  return entry?.isDirectory ? 'dir' : 'file'
}

/** 只有路径时按结尾分隔符判断目录（剪贴板拿不到 entry 的情况）。 */
function pathKind(path: string): 'file' | 'dir' {
  return /[\\/]$/.test(path) ? 'dir' : 'file'
}

/** 操作系统拖进输入框的文件（支持多个）；内建的 `FILE_DRAG_TYPE` 不在这里处理。 */
export function externalDroppedFiles(
  event: DragEvent,
  fromFile: ((file: File) => string) | undefined,
): ExternalFile[] {
  const items = event.dataTransfer.items
  if (items !== undefined && items.length > 0) {
    const result: ExternalFile[] = []
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file === null) continue
      const path = filePathFor(file, fromFile)
      if (path === undefined) continue
      result.push({ path, kind: entryKind(item.webkitGetAsEntry?.()) })
    }
    if (result.length > 0) return result
  }
  return Array.from(event.dataTransfer.files ?? []).flatMap((file) => {
    const path = filePathFor(file, fromFile)
    return path === undefined ? [] : [{ path, kind: 'file' as const }]
  })
}

/** 剪贴板里复制的文件（Finder / 资源管理器）；先看 File 对象，退回 `text/uri-list`。 */
export function pastedFilePaths(
  event: ClipboardEvent,
  fromFile: ((file: File) => string) | undefined,
): ExternalFile[] {
  const data = event.clipboardData
  if (data === undefined) return []
  const direct = Array.from(data.files ?? []).flatMap((file) => {
    const path = filePathFor(file, fromFile)
    return path === undefined ? [] : [{ path, kind: pathKind(path) }]
  })
  if (direct.length > 0) return direct
  // 部分平台只把文件放在 items 里。
  const items = data.items
  if (items !== undefined) {
    const fromItems: ExternalFile[] = []
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file === null) continue
      const path = filePathFor(file, fromFile)
      if (path !== undefined) {
        fromItems.push({ path, kind: entryKind(item.webkitGetAsEntry?.()) })
      }
    }
    if (fromItems.length > 0) return fromItems
  }
  if (typeof data.getData !== 'function') return []
  const uris = data.getData('text/uri-list')
  // GNOME 文件管理器使用自定义 MIME，格式同为逐行 file://。
  return fileUrisToPaths(uris === '' ? data.getData('x-special/gnome-copied-files') : uris)
}

/** 解析 `file://` 列表（Windows 的 `file:///C:/…` 也处理），目录以斜杠结尾。 */
export function fileUrisToPaths(text: string): ExternalFile[] {
  const result: ExternalFile[] = []
  for (const line of text.split(/\r?\n/)) {
    const uri = line.trim()
    if (uri === '' || uri.startsWith('#')) continue
    const lower = uri.toLowerCase()
    if (!lower.startsWith('file://')) continue
    const rest = uri.slice('file://'.length)
    const body = rest.startsWith('localhost/') ? rest.slice('localhost'.length) : rest
    let decoded: string
    try {
      decoded = decodeURIComponent(body)
    } catch {
      decoded = body
    }
    const directory = decoded.endsWith('/') || decoded.endsWith('\\')
    // file:///C:/path → 去掉盘符前的斜杠
    const windows = decoded.match(/^\/([A-Za-z]:\/.*)$/)
    const path = windows ? windows[1]! : decoded
    if (path === '') continue
    result.push({ path, kind: directory ? 'dir' : 'file' })
  }
  return result
}

/** 把绝对路径转成工作空间内的相对路径（`/` 分隔）；在工作空间外或等于根时返回 undefined。 */
export function relativeMentionPath(
  root: string,
  target: string,
  platform?: string,
): string | undefined {
  const windows = platform === 'win32'
  const normalize = (path: string) => {
    let value = path.replace(/\\/g, '/').replace(/\/+$/, '')
    if (windows) value = value.toLowerCase()
    return value
  }
  const r = normalize(root)
  if (r === '') return undefined
  const t = normalize(target)
  if (t === r || !t.startsWith(`${r}/`)) return undefined
  return target
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .slice(r.length + 1)
}
