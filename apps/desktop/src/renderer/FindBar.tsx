/**
 * 会话内查找条（⌘F / Ctrl+F）：在对话正文里查找文本，Enter / Shift+Enter 或按钮在结果间跳转。
 *
 * 高亮用 CSS Custom Highlight API，直接作用于渲染后的 Markdown、代码与工具输出，不改渲染结构；
 * 当前结果用另一层高亮并滚到视野中央。查找条本身不在搜索根之内，不会被自己的文字命中。
 */
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { findTextRanges, matchElement } from './find-text.js'
import { IconButton } from './ui/index.js'

const ALL_HIGHLIGHT = 'cairn-find'
const ACTIVE_HIGHLIGHT = 'cairn-find-active'
const NO_MATCHES: readonly Range[] = []

type HighlightCtor = new (...ranges: Range[]) => unknown

interface HighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

function highlightSupport():
  { readonly create: HighlightCtor; readonly registry: HighlightRegistry } | undefined {
  const create = (globalThis as { Highlight?: unknown }).Highlight as HighlightCtor | undefined
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  return typeof create === 'function' && registry !== undefined ? { create, registry } : undefined
}

export function FindBar({
  open,
  root,
  revision,
  focusToken,
  onClose,
}: {
  readonly open: boolean
  /** 搜索范围：对话正文容器的 ref。 */
  readonly root: RefObject<HTMLElement | null>
  /** 对话内容变化时重新计算（流式更新也用它触发）。 */
  readonly revision: unknown
  /** 再次按 ⌘F 时递增：把焦点交回输入框并全选。 */
  readonly focusToken: number
  readonly onClose: () => void
}) {
  const { t } = useTranslation('session')
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<readonly Range[]>([])
  const [active, setActive] = useState(0)

  // 关闭后清空查询：下次打开从空白开始，也不会留下旧高亮。
  useEffect(() => {
    if (open) return
    setQuery('')
    setMatches([])
    setActive(0)
  }, [open])

  // 查询或对话内容变化：重算命中，尽量保持当前序号。
  useEffect(() => {
    if (!open) return
    const element = root.current
    const found = element === null ? NO_MATCHES : findTextRanges(element, query)
    setMatches(found.length === 0 ? NO_MATCHES : found)
    setActive((current) => (found.length === 0 ? 0 : Math.min(current, found.length - 1)))
  }, [open, query, revision, root])

  // 高亮：全部命中一种颜色，当前命中另一种；关闭或卸载时移除。
  useEffect(() => {
    if (!open) return
    const support = highlightSupport()
    if (support === undefined) return
    support.registry.set(ALL_HIGHLIGHT, new support.create(...matches))
    const current = matches[active]
    if (current === undefined) support.registry.delete(ACTIVE_HIGHLIGHT)
    else support.registry.set(ACTIVE_HIGHLIGHT, new support.create(current))
    return () => {
      support.registry.delete(ALL_HIGHLIGHT)
      support.registry.delete(ACTIVE_HIGHLIGHT)
    }
  }, [open, matches, active])

  // 打开或再次按 ⌘F：聚焦并全选，直接输入就能换查询。
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open, focusToken])

  // 当前结果滚到视野中央；用可选调用兼容不实现 scrollIntoView 的测试环境。
  useEffect(() => {
    if (!open) return
    const range = matches[active]
    if (range === undefined) return
    matchElement(range)?.scrollIntoView?.({ block: 'center' })
  }, [open, matches, active])

  if (!open) return null

  const step = (delta: 1 | -1) => {
    if (matches.length === 0) return
    setActive((current) => (current + delta + matches.length) % matches.length)
  }
  const trimmed = query.trim()
  const status =
    trimmed === ''
      ? ''
      : matches.length === 0
        ? t('find.noResults')
        : t('find.count', { current: active + 1, total: matches.length })

  return (
    <div
      role="search"
      className="absolute top-2.5 right-3 z-20 flex h-9 items-center gap-1 rounded-item border border-hair bg-raise px-2 shadow-2"
    >
      <Search aria-hidden className="ml-0.5 size-3.5 shrink-0 text-muted" />
      <input
        ref={input}
        aria-label={t('find.placeholder')}
        placeholder={t('find.placeholder')}
        className="h-full w-[180px] min-w-0 bg-transparent text-note text-fg outline-none placeholder:text-faint"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          // 输入法组字时的 Esc / Enter 属于候选词操作，不关闭、也不跳转。
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Enter') return
          event.preventDefault()
          step(event.shiftKey ? -1 : 1)
        }}
      />
      <span
        aria-live="polite"
        className="tabular min-w-[42px] shrink-0 text-right text-[11.5px] text-muted"
      >
        {status}
      </span>
      <IconButton
        label={t('find.previous')}
        size="icon-sm"
        disabled={matches.length === 0}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(-1)}
      >
        <ArrowUp />
      </IconButton>
      <IconButton
        label={t('find.next')}
        size="icon-sm"
        disabled={matches.length === 0}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(1)}
      >
        <ArrowDown />
      </IconButton>
      <IconButton label={t('find.close')} size="icon-sm" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  )
}
