/**
 * 输入框上方的附件条（ADR-0052）：图片显示缩略图，其它文件显示名称与大小，每个都能单独移除。
 * 图片的预览优先用粘贴时生成的 data URL；恢复草稿时按需从主进程读取。
 */
import { FileText, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  attachmentPreview,
  formatAttachmentSize,
  type PendingAttachment,
} from './composer-attachments.js'

function ImageThumb({ attachment }: { readonly attachment: PendingAttachment }) {
  const { t } = useTranslation('session')
  const [src, setSrc] = useState(attachment.preview)
  useEffect(() => {
    if (src !== undefined) return
    let alive = true
    void attachmentPreview(attachment.blobRef, attachment.mimeType).then((value) => {
      if (alive) setSrc(value)
    })
    return () => {
      alive = false
    }
  }, [attachment.blobRef, attachment.mimeType, src])

  if (src === undefined) {
    return (
      <span className="flex size-16 items-center justify-center rounded-[8px] border border-hair bg-sunk2 text-note text-faint">
        {t('message.image')}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={attachment.name}
      title={attachment.name}
      className="size-16 rounded-[8px] border border-hair object-cover"
    />
  )
}

function FileChip({ attachment }: { readonly attachment: PendingAttachment }) {
  return (
    <span
      title={attachment.name}
      className="flex h-9 max-w-56 items-center gap-1.5 rounded-[8px] border border-hair bg-sunk2 px-2 text-note text-fg2"
    >
      <FileText aria-hidden className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span className="shrink-0 text-faint">{formatAttachmentSize(attachment.size)}</span>
    </span>
  )
}

export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  readonly attachments: readonly PendingAttachment[]
  readonly onRemove: (blobRef: string) => void
}) {
  const { t } = useTranslation('session')
  if (attachments.length === 0) return null
  return (
    <ul aria-label={t('input.attachments')} className="mb-2 flex flex-wrap items-center gap-2">
      {attachments.map((attachment) => (
        <li key={attachment.blobRef} className="relative">
          {attachment.kind === 'image' ? (
            <ImageThumb attachment={attachment} />
          ) : (
            <FileChip attachment={attachment} />
          )}
          <button
            type="button"
            aria-label={t('input.attachment.remove')}
            title={t('input.attachment.remove')}
            onClick={() => onRemove(attachment.blobRef)}
            className="absolute -right-1.5 -top-1.5 flex size-[18px] items-center justify-center rounded-full bg-ink text-ink-fg shadow-1 outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X aria-hidden className="size-2.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}
