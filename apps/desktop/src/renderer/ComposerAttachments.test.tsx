// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import { ComposerAttachments } from './ComposerAttachments.js'
import type { PendingAttachment } from './composer-attachments.js'
import { clearAttachmentPreviews } from './composer-attachments.js'

const i18n = createI18n('zh-CN')

const image = (blobRef: string, preview?: string): PendingAttachment => ({
  blobRef,
  kind: 'image',
  name: '截图.png',
  mimeType: 'image/png',
  size: 2048,
  ...(preview === undefined ? {} : { preview }),
})

const file: PendingAttachment = {
  blobRef: 'b2',
  kind: 'file',
  name: '报告.pdf',
  mimeType: 'application/pdf',
  size: 1.5 * 1024 * 1024,
}

function renderAttachments(attachments: readonly PendingAttachment[], onRemove = vi.fn()) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ComposerAttachments attachments={attachments} onRemove={onRemove} />
    </I18nextProvider>,
  )
}

beforeEach(() => {
  clearAttachmentPreviews()
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('ComposerAttachments', () => {
  it('没有附件时不渲染', () => {
    const { container } = renderAttachments([])
    expect(container.firstChild).toBeNull()
  })

  it('文件显示名称与大小，图片带预览显示缩略图', () => {
    const { container } = renderAttachments([image('b1', 'data:image/png;base64,AAAA'), file])
    expect(screen.getByLabelText('附件')).toBeTruthy()
    expect(screen.getByText('报告.pdf')).toBeTruthy()
    expect(screen.getByText('1.5 MB')).toBeTruthy()
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(img.getAttribute('alt')).toBe('截图.png')
  })

  it('没有预览时占位，从主进程读回后显示', async () => {
    const mainApi = {
      request: vi.fn(async () => ({ ok: true, result: { data: 'AQID' } })),
    }
    vi.stubGlobal('cairn', mainApi)
    renderAttachments([image('b9')])
    expect(screen.getByText('[图片]')).toBeTruthy()

    await vi.waitFor(() => {
      expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AQID')
    })
    expect(mainApi.request).toHaveBeenCalledWith('attachment.read', { blobRef: 'b9' }, undefined)
    vi.unstubAllGlobals()
  })

  it('点击移除按钮回传 blobRef', () => {
    const onRemove = vi.fn()
    renderAttachments([image('b1', 'data:image/png;base64,AAAA')], onRemove)
    fireEvent.click(screen.getByLabelText('移除附件'))
    expect(onRemove).toHaveBeenCalledWith('b1')
  })

  it('卸载后不再更新预览', async () => {
    let resolveRead!: (value: unknown) => void
    const mainApi = {
      request: vi.fn(() => new Promise((resolve) => (resolveRead = resolve))),
    }
    vi.stubGlobal('cairn', mainApi)
    const { unmount } = renderAttachments([image('b9')])
    unmount()
    resolveRead({ ok: true, result: { data: 'AQID' } })
    await vi.waitFor(() => expect(mainApi.request).toHaveBeenCalled())
    vi.unstubAllGlobals()
  })
})
