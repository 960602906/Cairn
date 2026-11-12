/**
 * 输入框的 `@` 引用候选（ADR-0037）。
 *
 * 光标前是开头或空白后面的 `@查询` 时弹出候选：空查询列出第一层，`目录/` 列出这个目录的下一层，
 * 其他按路径模糊匹配（主进程的 `fs.search`，遵守 `.gitignore`）。↑↓ 选择，Enter 插入，
 * Tab 在文件夹上时进入它继续选，Esc 关闭。插入的是纯文字 `@路径 `，发送时由 store 从草稿里解析，
 * 所以手打的引用和选出来的引用一样生效。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FileSearchEntry } from '@cairn/protocol'
import { activeMention, mentionText } from './composer-tokens.js'
import { FileTypeIcon, FolderTypeIcon } from './file-icons.js'
import { useSessionStore } from './store-context.js'
import { cn } from './ui/index.js'

/** 在哪里搜：会话的工作区，或者（还没有会话时）项目目录。 */
export type MentionScope = { readonly sessionId: string } | { readonly projectId: string }

/** `@` 候选里的 Agent：名称用于插入草稿，说明只在菜单里显示。 */
export interface MentionAgent {
  readonly agentId: string
  readonly name: string
  readonly description: string
}

const SEARCH_LIMIT = 50
/** 打字时等多久再搜（毫秒）。 */
const SEARCH_DELAY_MS = 60
export const MENTION_LIST_ID = 'composer-mention-list'

type Results = {
  readonly key: string
  readonly entries: readonly FileSearchEntry[]
  readonly truncated: boolean
}

type MentionOption =
  | FileSearchEntry
  | {
      readonly kind: 'agent'
      readonly agentId: string
      readonly name: string
      readonly description: string
    }

const isAgent = (option: MentionOption): option is Extract<MentionOption, { kind: 'agent' }> =>
  option.kind === 'agent'

export interface MentionMenu {
  readonly open: boolean
  /** 处理了这次按键时返回 true，输入框不再处理。 */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** 光标移动（点击、方向键、选区变化）时调用。 */
  readonly onCaret: () => void
  readonly activeId: string | undefined
  readonly list: ReactNode
}

export function useMentionMenu({
  text,
  setText,
  textarea,
  root,
  scope,
  agents = [],
  disabled = false,
}: {
  readonly text: string
  readonly setText: (text: string) => void
  readonly textarea: RefObject<HTMLTextAreaElement | null>
  /** 输入框整体；在它外面按下鼠标时关闭候选。 */
  readonly root: RefObject<HTMLElement | null>
  readonly scope: MentionScope | undefined
  /** 可用的 Agent，排在文件前面；空查询时也列出。 */
  readonly agents?: readonly MentionAgent[]
  readonly disabled?: boolean
}): MentionMenu {
  const { t } = useTranslation('session')
  const searchFiles = useSessionStore((s) => s.searchFiles)
  const [caret, setCaret] = useState(0)
  const [index, setIndex] = useState(0)
  const [results, setResults] = useState<Results>()
  const [dismissed, setDismissed] = useState<string>()
  const pendingCaret = useRef<number | undefined>(undefined)

  const scopeKey =
    scope === undefined ? undefined : 'sessionId' in scope ? scope.sessionId : scope.projectId
  const mention = disabled ? undefined : activeMention(text, caret)
  const key = mention === undefined ? undefined : `${scopeKey}\n${mention.start}\n${mention.query}`
  // 没有可搜的目录时仍然可以列出 Agent（新对话页还没选项目）。
  const open =
    key !== undefined &&
    dismissed !== key &&
    (scope !== undefined || agents.length > 0) &&
    mention !== undefined
  const current = key !== undefined && results?.key === key ? results : undefined
  const fileEntries = current?.entries ?? []
  const loading = open && scope !== undefined && current === undefined
  const agentQuery = (mention?.query ?? '').trim().toLowerCase()
  const matchingAgents: MentionOption[] = open
    ? agents
        .filter(
          (agent) =>
            agentQuery === '' ||
            agent.name.toLowerCase().includes(agentQuery) ||
            agent.description.toLowerCase().includes(agentQuery),
        )
        .map((agent) => ({ kind: 'agent' as const, ...agent }))
    : []
  const options = [...matchingAgents, ...fileEntries].slice(0, SEARCH_LIMIT)
  const active = options.length === 0 ? -1 : Math.min(index, options.length - 1)

  const onCaret = () => {
    const el = textarea.current
    if (el) setCaret(el.selectionStart)
  }

  // 文字变了之后同步光标；插入候选后把光标放到插入的文字后面。
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    if (pendingCaret.current !== undefined) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = undefined
    }
    setCaret(el.selectionStart)
  }, [text, textarea])

  useEffect(() => setIndex(0), [key])

  const query = mention?.query
  useEffect(() => {
    if (!open || scope === undefined || query === undefined || key === undefined) return
    let cancelled = false
    const timer = setTimeout(() => {
      void searchFiles(scope, query, SEARCH_LIMIT).then((result) => {
        if (!cancelled) setResults({ key, entries: result.entries, truncated: result.truncated })
      })
    }, SEARCH_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // scope 只通过 key 参与比较，避免父组件每次渲染新建对象时重复搜索。
  }, [open, key, query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target) === true) return
      setDismissed(key)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, key, root])

  /** 用选中的候选替换 `@查询`。`enter` 为 true 时进入文件夹继续选，不加结尾空格。 */
  const choose = (option: MentionOption, enter: boolean) => {
    if (mention === undefined) return
    const replacement = isAgent(option)
      ? mentionText(option.name, 'agent')
      : enter && option.kind === 'dir'
        ? mentionText(option.path, 'dir').trimEnd().replace(/"$/, '')
        : mentionText(option.path, option.kind)
    const next = text.slice(0, mention.start) + replacement + text.slice(caret)
    pendingCaret.current = mention.start + replacement.length
    setText(next)
    textarea.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(key)
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return false
      event.preventDefault()
      setIndex((current) => {
        const base = Math.min(current, options.length - 1)
        const next = event.key === 'ArrowDown' ? base + 1 : base - 1
        return (next + options.length) % options.length
      })
      return true
    }
    const entry = options[active]
    if (entry === undefined) return false
    if ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      choose(entry, event.key === 'Tab')
      return true
    }
    return false
  }

  const list = open ? (
    <div
      id={MENTION_LIST_ID}
      role="listbox"
      aria-label={t('composer.mention.label')}
      className="absolute inset-x-0 bottom-full z-50 mb-2 max-h-64 overflow-y-auto rounded-card bg-raise p-1 text-ui text-fg shadow-2"
    >
      {options.length === 0 ? (
        <p className="px-2 py-2 text-note text-muted">
          {loading ? t('composer.mention.loading') : t('composer.mention.empty')}
        </p>
      ) : (
        options.map((option, position) => {
          if (isAgent(option)) {
            return (
              <div
                key={`agent:${option.agentId}`}
                id={`composer-mention-${position}`}
                role="option"
                aria-selected={position === active}
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(option, false)
                }}
                onMouseEnter={() => setIndex(position)}
                className={cn(
                  'flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5',
                  position === active && 'bg-hover',
                )}
              >
                <Bot aria-hidden className="size-4 shrink-0 text-muted" />
                <span className="shrink-0 text-note text-fg">{option.name}</span>
                {option.description !== '' && (
                  <span className="min-w-0 truncate text-note text-faint">
                    {option.description}
                  </span>
                )}
              </div>
            )
          }
          const slash = option.path.lastIndexOf('/')
          const name = option.path.slice(slash + 1)
          const parent = slash === -1 ? '' : option.path.slice(0, slash)
          return (
            <div
              key={`${option.kind}:${option.path}`}
              id={`composer-mention-${position}`}
              role="option"
              aria-selected={position === active}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(option, false)
              }}
              onMouseEnter={() => setIndex(position)}
              className={cn(
                'flex cursor-default select-none items-center gap-2 rounded-[7px] px-2 py-1.5',
                position === active && 'bg-hover',
              )}
            >
              {option.kind === 'dir' ? (
                <FolderTypeIcon name={name} />
              ) : (
                <FileTypeIcon name={name} />
              )}
              <span className="shrink-0 text-note text-fg">
                {name}
                {option.kind === 'dir' ? '/' : ''}
              </span>
              {parent !== '' && (
                <span className="min-w-0 truncate text-note text-faint" dir="rtl">
                  {/* rtl 让过长的目录从左边截断，保留离文件最近的部分 */}
                  <bdi>{parent}</bdi>
                </span>
              )}
            </div>
          )
        })
      )}
      <p className="mt-1 border-t border-hair px-2 pt-1.5 text-[11px] text-faint">
        {current?.truncated === true ? t('composer.mention.truncated') : t('composer.mention.hint')}
      </p>
    </div>
  ) : null

  return {
    open,
    onKeyDown,
    onCaret,
    activeId: open && active >= 0 ? `composer-mention-${active}` : undefined,
    list,
  }
}
