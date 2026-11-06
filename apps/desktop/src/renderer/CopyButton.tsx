/** 代码卡片、终端卡片标题栏的复制按钮（视觉规范 §7.1）：复制后显示“已复制”1.6 秒。 */
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from './ui/index.js'

export const COPIED_MS = 1600

export function CopyButton({
  text,
  className,
}: {
  /** 复制的内容；函数在点击时才计算（例如去掉 ANSI 控制符）。 */
  readonly text: string | (() => string)
  readonly className?: string
}) {
  const { t } = useTranslation('session')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
      setCopied(true)
    } catch {
      // 剪贴板不可用时不提示
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-note transition-colors [&_svg]:size-3.5',
        className,
      )}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? t('code.copied') : t('code.copy')}</span>
    </button>
  )
}
