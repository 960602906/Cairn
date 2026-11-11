/**
 * 输入框的高亮层：叠在 `<textarea>` 下面，用完全相同的排版把草稿再画一遍，
 * 给 `/` 指令、网址和代码片段加上样式。文本框本身的文字是透明的，只留光标和选区，
 * 所以输入法、撤销、粘贴都还是浏览器原生的行为。
 *
 * 两层必须逐字对齐：高亮只能用不影响宽度的样式（底色、下划线），不能换字体或加内边距。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { tokenize, type ComposerTokenType } from './composer-tokens.js'
import { cn } from './ui/index.js'

const TOKEN_CLASS: Readonly<Record<Exclude<ComposerTokenType, 'text'>, string>> = {
  command: 'rounded-[4px] bg-accent-soft',
  code: 'rounded-[4px] bg-sunk2',
  url: 'underline decoration-hair2 underline-offset-[3px]',
}

export interface ComposerHighlightProps {
  readonly text: string
  /** 可用指令的名称（不含斜杠）。 */
  readonly commands: readonly string[]
  /** 被覆盖的文本框：用来对齐宽度（出现滚动条时变窄）和滚动位置。 */
  readonly textarea: RefObject<HTMLTextAreaElement | null>
  readonly className?: string
}

export function ComposerHighlight({ text, commands, textarea, className }: ComposerHighlightProps) {
  const layer = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const input = textarea.current
    const el = layer.current
    if (!input || !el) return
    const sync = () => {
      // 文本框出现滚动条后内容区变窄，高亮层跟着变窄才能在同一处换行。
      el.style.width = input.clientWidth > 0 ? `${input.clientWidth}px` : ''
      el.style.transform = `translateY(${-input.scrollTop}px)`
    }
    sync()
    input.addEventListener('scroll', sync)
    return () => input.removeEventListener('scroll', sync)
  }, [text, textarea])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={layer} data-composer-highlight className={cn('whitespace-pre-wrap', className)}>
        {tokenize(text, { commands }).map((token) =>
          token.type === 'text' ? (
            token.text
          ) : (
            <span key={token.start} data-token={token.type} className={TOKEN_CLASS[token.type]}>
              {token.text}
            </span>
          ),
        )}
      </div>
    </div>
  )
}
