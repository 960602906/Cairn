// @vitest-environment jsdom
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES } from '@cairn/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardEvent, DragEvent } from 'react'
import {
  attachmentLimit,
  attachmentPart,
  attachmentPreview,
  clearAttachmentPreviews,
  droppedAttachmentFiles,
  formatAttachmentSize,
  pastedAttachmentFiles,
  saveAttachment,
} from './composer-attachments.js'

const fromFile = (file: File) => (file as File & { path?: string }).path ?? ''

const fileWithPath = (path: string, type = ''): File => ({ path, type }) as unknown as File
const fileWithoutPath = (type = 'text/plain'): File => ({ type, size: 3 }) as unknown as File

const clipboard = (data: unknown): ClipboardEvent =>
  ({ clipboardData: data }) as unknown as ClipboardEvent
const drag = (dataTransfer: unknown): DragEvent => ({ dataTransfer }) as unknown as DragEvent

afterEach(() => {
  vi.restoreAllMocks()
  clearAttachmentPreviews()
})

describe('attachmentPart / attachmentLimit', () => {
  it('图片与文件分别生成内容片段', () => {
    expect(
      attachmentPart({
        blobRef: 'b1',
        kind: 'image',
        name: 'a.png',
        mimeType: 'image/png',
        size: 1,
      }),
    ).toEqual({ type: 'image', blobRef: 'b1', mimeType: 'image/png' })
    expect(
      attachmentPart({
        blobRef: 'b2',
        kind: 'file',
        name: 'a.md',
        mimeType: 'text/markdown',
        size: 2,
      }),
    ).toEqual({ type: 'file', blobRef: 'b2', name: 'a.md', mimeType: 'text/markdown', size: 2 })
  })

  it('图片和其它文件的大小上限不同', () => {
    expect(attachmentLimit('image/png')).toBe(MAX_IMAGE_BYTES)
    expect(attachmentLimit('application/pdf')).toBe(MAX_FILE_BYTES)
    expect(attachmentLimit('')).toBe(MAX_FILE_BYTES)
  })
})

describe('pastedAttachmentFiles / droppedAttachmentFiles', () => {
  it('剪贴板里没有路径的文件才是附件；有路径的留给 @ 引用', () => {
    expect(
      pastedAttachmentFiles(
        clipboard({ files: [fileWithoutPath(), fileWithPath('/w/a.txt')] }),
        fromFile,
      ).map((file) => file.type),
    ).toEqual(['text/plain'])
  })

  it('files 为空时退回 items；没有剪贴板数据时返回空', () => {
    const item = (kind: string, file: File | null) => ({ kind, getAsFile: () => file })
    expect(
      pastedAttachmentFiles(
        clipboard({
          files: [],
          items: [
            item('string', null),
            item('file', fileWithoutPath()),
            item('file', fileWithPath('/w/a')),
          ],
        }),
        fromFile,
      ),
    ).toHaveLength(1)
    // items 缺失或条目读不出文件时为空。
    expect(pastedAttachmentFiles(clipboard({ files: [], items: undefined }), fromFile)).toEqual([])
    expect(
      pastedAttachmentFiles(clipboard({ files: [], items: [item('file', null)] }), fromFile),
    ).toEqual([])
    expect(pastedAttachmentFiles(clipboard(undefined), fromFile)).toEqual([])
    expect(pastedAttachmentFiles(clipboard({ files: undefined, items: [] }), fromFile)).toEqual([])
  })

  it('拖入没有路径的文件作为附件', () => {
    expect(
      droppedAttachmentFiles(
        drag({ files: [fileWithPath('/w/a.txt'), fileWithoutPath('image/png')] }),
        fromFile,
      ),
    ).toHaveLength(1)
    expect(droppedAttachmentFiles(drag({ files: [] }), fromFile)).toEqual([])
    expect(droppedAttachmentFiles(drag({ files: undefined }), fromFile)).toEqual([])
  })
})

describe('saveAttachment', () => {
  const api = { request: vi.fn() }

  it('超过大小上限直接拒绝', async () => {
    const big = { type: 'application/pdf', size: MAX_FILE_BYTES + 1 } as unknown as File
    expect(await saveAttachment(big, api as never)).toEqual({ error: 'input.attachment.tooLarge' })
    const bigImage = { type: 'image/png', size: MAX_IMAGE_BYTES + 1 } as unknown as File
    expect(await saveAttachment(bigImage, api as never)).toEqual({
      error: 'input.attachment.tooLarge',
    })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('没有主进程 API 时失败', async () => {
    expect(await saveAttachment(fileWithoutPath(), undefined)).toEqual({
      error: 'input.attachment.failed',
    })
  })

  it('保存成功：图片带预览，文件不带', async () => {
    vi.mocked(api.request).mockResolvedValueOnce({
      blobRef: 'b1',
      kind: 'image',
      name: '截图.png',
      mimeType: 'image/png',
      size: 3,
    })
    const image = await saveAttachment(
      new File([new Uint8Array([1, 2, 3])], '截图.png', { type: 'image/png' }),
      api as never,
    )
    expect(image).toEqual({
      attachment: {
        blobRef: 'b1',
        kind: 'image',
        name: '截图.png',
        mimeType: 'image/png',
        size: 3,
        preview: expect.stringMatching(/^data:image\/png;base64,/),
      },
    })
    expect(api.request).toHaveBeenCalledWith(
      'attachment.save',
      expect.objectContaining({ name: '截图.png', mimeType: 'image/png' }),
    )

    vi.mocked(api.request).mockResolvedValueOnce({
      blobRef: 'b2',
      kind: 'file',
      name: 'a.md',
      mimeType: 'text/markdown',
      size: 3,
    })
    const doc = await saveAttachment(
      new File([new Uint8Array([1, 2, 3])], 'a.md', { type: 'text/markdown' }),
      api as never,
    )
    expect(doc).toEqual({
      attachment: {
        blobRef: 'b2',
        kind: 'file',
        name: 'a.md',
        mimeType: 'text/markdown',
        size: 3,
      },
    })
  })

  it('读文件失败或主进程拒绝时失败', async () => {
    // 读出非字符串结果或触发 onerror 都算失败。
    class StubReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      result: unknown = 42
      readAsDataURL() {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('FileReader', StubReader)
    expect(await saveAttachment(fileWithoutPath(), api as never)).toEqual({
      error: 'input.attachment.failed',
    })

    class FailingReader extends StubReader {
      override readAsDataURL() {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', FailingReader)
    expect(await saveAttachment(fileWithoutPath(), api as never)).toEqual({
      error: 'input.attachment.failed',
    })

    class ThrowingReader {
      readAsDataURL() {
        throw new Error('blocked')
      }
    }
    vi.stubGlobal('FileReader', ThrowingReader)
    expect(await saveAttachment(fileWithoutPath(), api as never)).toEqual({
      error: 'input.attachment.failed',
    })
    vi.unstubAllGlobals()

    vi.mocked(api.request).mockRejectedValueOnce(new Error('attachment.too_large'))
    expect(
      await saveAttachment(
        new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' }),
        api as never,
      ),
    ).toEqual({ error: 'input.attachment.failed' })
  })

  it('文件没有名字或类型时用回退值', async () => {
    vi.mocked(api.request).mockResolvedValueOnce({
      blobRef: 'b3',
      kind: 'file',
      name: 'attachment',
      mimeType: 'application/octet-stream',
      size: 1,
    })
    const result = await saveAttachment(new File([new Uint8Array([1])], '', {}), api as never)
    expect(result).toMatchObject({
      attachment: { blobRef: 'b3', name: 'attachment', mimeType: 'application/octet-stream' },
    })
    expect(api.request).toHaveBeenCalledWith(
      'attachment.save',
      expect.objectContaining({ name: 'attachment', mimeType: 'application/octet-stream' }),
    )
  })
})

describe('attachmentPreview', () => {
  const api = { request: vi.fn() }

  it('读到后拼成 data URL，同一个引用只读一次', async () => {
    vi.mocked(api.request).mockResolvedValue({ data: 'AQID' })
    const first = await attachmentPreview('b1', 'image/png', api as never)
    const second = await attachmentPreview('b1', 'image/png', api as never)
    expect(first).toBe('data:image/png;base64,AQID')
    expect(second).toBe(first)
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it('没有 API 或读取失败时返回 undefined', async () => {
    expect(await attachmentPreview('b1', 'image/png', undefined)).toBeUndefined()
    vi.mocked(api.request).mockRejectedValueOnce(new Error('attachment.not_found'))
    expect(await attachmentPreview('b2', 'image/png', api as never)).toBeUndefined()
  })
})

describe('formatAttachmentSize', () => {
  it('按数量级格式化', () => {
    expect(formatAttachmentSize(0)).toBe('0 B')
    expect(formatAttachmentSize(1023)).toBe('1023 B')
    expect(formatAttachmentSize(1024)).toBe('1.0 KB')
    expect(formatAttachmentSize(9.5 * 1024)).toBe('9.5 KB')
    expect(formatAttachmentSize(10 * 1024)).toBe('10 KB')
    expect(formatAttachmentSize(1536 * 1024)).toBe('1.5 MB')
    expect(formatAttachmentSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })
})
