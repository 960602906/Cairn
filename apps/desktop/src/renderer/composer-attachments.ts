/**
 * 输入框的附件（ADR-0052）：粘贴 / 拖入的截图与文件先保存到主进程的 blob 存储，发送时随输入带上。
 *
 * - 有磁盘路径的文件（Finder / 资源管理器复制）仍走 `@` 引用（ADR-0037），这里只处理剪贴板 / 拖拽里
 *   只有内容、没有路径的文件：截图、从浏览器拖来的图片、从其它应用复制的文档。
 * - 图片直接给模型看；其它文件在发送时由主进程抽取文字。
 * - 草稿只记 `blobRef` 与元信息；预览按需通过 `attachment.read` 读取。
 */
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_ATTACHMENTS,
  type ContentPart,
} from '@cairn/protocol'
import type { ClipboardEvent, DragEvent } from 'react'
import { filePathFor } from './file-drag.js'
import { getMainApi, type MainApi } from './api.js'

export { MAX_PROMPT_ATTACHMENTS }

/** 输入框里待发送的附件。图片的 `preview` 是本地 data URL，草稿里不保存。 */
export interface PendingAttachment {
  readonly blobRef: string
  readonly kind: 'image' | 'file'
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly preview?: string
}

/** 草稿里保存的附件：只保留可以重新读取的引用。 */
export type DraftAttachment = Omit<PendingAttachment, 'preview'>

export type AttachmentError = 'input.attachment.tooLarge' | 'input.attachment.failed'

export type SaveAttachmentResult =
  { readonly attachment: PendingAttachment } | { readonly error: AttachmentError }

/** 附件内容片段（图片带 blob 引用，文件带名称与大小）。 */
export function attachmentPart(attachment: DraftAttachment): ContentPart {
  return attachment.kind === 'image'
    ? { type: 'image', blobRef: attachment.blobRef, mimeType: attachment.mimeType }
    : {
        type: 'file',
        blobRef: attachment.blobRef,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }
}

/** 文件大小上限：图片比其它文件更严格（模型对图片大小更敏感）。 */
export function attachmentLimit(mimeType: string): number {
  return mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
}

/** 从剪贴板取出没有磁盘路径的文件（截图等）；有路径的文件由 `pastedFilePaths` 处理。 */
export function pastedAttachmentFiles(
  event: ClipboardEvent,
  fromFile: ((file: File) => string) | undefined,
): File[] {
  const data = event.clipboardData
  if (data === undefined) return []
  const files: File[] = Array.from(data.files ?? [])
  if (files.length === 0) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file !== null) files.push(file)
    }
  }
  return files.filter((file) => filePathFor(file, fromFile) === undefined)
}

/** 从拖拽里取出没有磁盘路径的文件；有路径的文件由 `externalDroppedFiles` 处理。 */
export function droppedAttachmentFiles(
  event: DragEvent,
  fromFile: ((file: File) => string) | undefined,
): File[] {
  const files = Array.from(event.dataTransfer.files ?? [])
  return files.filter((file) => filePathFor(file, fromFile) === undefined)
}

function readDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
      reader.onerror = () => resolve(undefined)
      reader.readAsDataURL(file)
    } catch {
      resolve(undefined)
    }
  })
}

/** 保存一个粘贴 / 拖入的文件；失败时返回给界面显示的文案 key。 */
export async function saveAttachment(
  file: File,
  api: MainApi | undefined = getMainApi(),
): Promise<SaveAttachmentResult> {
  if (file.size > attachmentLimit(file.type)) return { error: 'input.attachment.tooLarge' }
  if (api === undefined) return { error: 'input.attachment.failed' }
  const dataUrl = await readDataUrl(file)
  const comma = dataUrl?.indexOf(',') ?? -1
  if (dataUrl === undefined || comma === -1) return { error: 'input.attachment.failed' }
  try {
    const saved = await api.request('attachment.save', {
      name: file.name === '' ? 'attachment' : file.name,
      mimeType: file.type === '' ? 'application/octet-stream' : file.type,
      data: dataUrl.slice(comma + 1),
    })
    return {
      attachment: {
        blobRef: saved.blobRef,
        kind: saved.kind,
        name: saved.name,
        mimeType: saved.mimeType,
        size: saved.size,
        ...(saved.kind === 'image' ? { preview: dataUrl } : {}),
      },
    }
  } catch {
    return { error: 'input.attachment.failed' }
  }
}

/** 预览缓存：同一条消息里的图片只读一次。 */
const previews = new Map<string, Promise<string | undefined>>()

/** 读取图片附件的 data URL；读不到时为 undefined。 */
export function attachmentPreview(
  blobRef: string,
  mimeType: string,
  api: MainApi | undefined = getMainApi(),
): Promise<string | undefined> {
  const cached = previews.get(blobRef)
  if (cached !== undefined) return cached
  const promise = (async () => {
    if (api === undefined) return undefined
    try {
      const { data } = await api.request('attachment.read', { blobRef })
      return `data:${mimeType};base64,${data}`
    } catch {
      return undefined
    }
  })()
  previews.set(blobRef, promise)
  return promise
}

/** 供测试清理预览缓存。 */
export function clearAttachmentPreviews(): void {
  previews.clear()
}

/** 文件大小的人类可读形式。 */
export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
