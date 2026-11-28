/**
 * 输入框与新建会话页的模型选择器。
 *
 * 紧凑触发按钮只显示模型短名；打开后是可搜索的浮层：顶部最近选用、下方按供应商分组（带协议图标），
 * 长列表虚拟滚动；思考强度钉在底部不随列表滚走。最近记录写在 localStorage（`cairn.recentModels`）。
 */
import { Brain, Check, ChevronDown, Search, Wrench } from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelRef, ProviderConfig, ProviderKind, ReasoningEffort } from '@cairn/protocol'
import { enabledModelChoices, modelLabels, sameModel, type ModelChoice } from './model-labels.js'
import {
  readRecentModels,
  rememberRecentModel,
  resolveRecentChoices,
  modelRefKey,
} from './recent-models.js'
import { formatTokens } from './settings/providers-model.js'
import { ProviderBrandIcon } from './settings/ProviderBrandIcon.js'
import { cn, Popover, PopoverContent, PopoverTrigger } from './ui/index.js'

/** 思考强度的三档；模型不支持推理时显示说明。 */
const THINKING_LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

const HEADER_H = 26
const ROW_H = 32
const LIST_MAX_H = 288
/** 超过这个行数才开虚拟滚动，短列表直接渲染以免测试与键盘焦点绕弯。 */
export const MODEL_PICKER_VIRTUALIZE_AFTER = 14
/** 启用模型达到这个数量才显示搜索框；更少时列表本身够扫。 */
export const MODEL_PICKER_SEARCH_AFTER = 10
const OVERSCAN = 6

type ListRow =
  | {
      readonly kind: 'header'
      readonly key: string
      readonly label: string
      readonly protocol?: ProviderKind
    }
  | {
      readonly kind: 'option'
      readonly key: string
      readonly choice: ModelChoice
      readonly optionIndex: number
    }

function matchesQuery(choice: ModelChoice, query: string): boolean {
  if (query === '') return true
  const hay = `${choice.name}\n${choice.ref.modelId}\n${choice.provider}`.toLowerCase()
  return hay.includes(query)
}

/** 组装列表行：搜索为空时顶部是最近（并从供应商分组里去掉，避免双列）；有搜索词时只按供应商分组。 */
export function buildModelPickerRows(
  choices: readonly ModelChoice[],
  recent: readonly ModelRef[],
  query: string,
  recentLabel: string,
): { readonly rows: readonly ListRow[]; readonly options: readonly ModelChoice[] } {
  const text = query.trim().toLowerCase()
  const filtered = choices.filter((choice) => matchesQuery(choice, text))
  const recentChoices =
    text === '' ? resolveRecentChoices(filtered, recent).filter((c) => matchesQuery(c, text)) : []
  const recentKeys = new Set(recentChoices.map((c) => modelRefKey(c.ref)))
  const groupedSource =
    text === '' ? filtered.filter((choice) => !recentKeys.has(modelRefKey(choice.ref))) : filtered

  const rows: ListRow[] = []
  const options: ModelChoice[] = []

  if (recentChoices.length > 0) {
    rows.push({ kind: 'header', key: 'recent', label: recentLabel })
    for (const choice of recentChoices) {
      rows.push({
        kind: 'option',
        key: `recent:${modelRefKey(choice.ref)}`,
        choice,
        optionIndex: options.length,
      })
      options.push(choice)
    }
  }

  let lastProviderId: string | undefined
  for (const choice of groupedSource) {
    if (choice.ref.providerId !== lastProviderId) {
      lastProviderId = choice.ref.providerId
      rows.push({
        kind: 'header',
        key: `provider:${choice.ref.providerId}`,
        label: choice.provider,
        protocol: choice.kind,
      })
    }
    rows.push({
      kind: 'option',
      key: modelRefKey(choice.ref),
      choice,
      optionIndex: options.length,
    })
    options.push(choice)
  }

  return { rows, options }
}

function rowHeight(row: ListRow): number {
  return row.kind === 'header' ? HEADER_H : ROW_H
}

function rowOffsets(rows: readonly ListRow[]): number[] {
  const offsets: number[] = [0]
  for (const row of rows) offsets.push(offsets[offsets.length - 1]! + rowHeight(row))
  return offsets
}

function QuietChip({ children, title }: { readonly children: ReactNode; readonly title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-[16px] shrink-0 items-center gap-0.5 rounded-[4px] bg-paper px-1 text-[10px] font-medium tabular-nums whitespace-nowrap text-muted shadow-[inset_0_0_0_0.5px_var(--hair2)] [&_svg]:size-2.5"
    >
      {children}
    </span>
  )
}

function ModelMetaChips({ choice }: { readonly choice: ModelChoice }) {
  const { t } = useTranslation('session')
  return (
    <span className="flex shrink-0 items-center gap-1">
      <QuietChip title={t('composer.model.context', { size: formatTokens(choice.contextWindow) })}>
        {formatTokens(choice.contextWindow)}
      </QuietChip>
      {choice.supportsReasoning && (
        <QuietChip title={t('composer.model.reasoning')}>
          <Brain aria-hidden />
          <span className="sr-only">{t('composer.model.reasoning')}</span>
        </QuietChip>
      )}
      {choice.supportsTools && (
        <QuietChip title={t('composer.model.tools')}>
          <Wrench aria-hidden />
          <span className="sr-only">{t('composer.model.tools')}</span>
        </QuietChip>
      )}
    </span>
  )
}

export function ModelPicker({
  providers,
  model,
  fixed,
  disabled,
  open,
  onOpenChange,
  onSelect,
  thinkingLevel,
  onSelectThinkingLevel,
  align = 'end',
  returnFocus,
}: {
  readonly providers: readonly ProviderConfig[]
  readonly model: ModelRef | undefined
  /** Agent 固定了模型（M3-12）：显示当前模型并禁用。 */
  readonly fixed: boolean
  /** 没有可选模型时禁用。 */
  readonly disabled: boolean
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSelect: (model: ModelRef) => void
  /** 本会话设定的思考强度；没有时用模型配置里的默认值。 */
  readonly thinkingLevel?: ReasoningEffort | undefined
  /** 给出时才能改思考强度；没有会话（新会话页）时不显示这一段。 */
  readonly onSelectThinkingLevel?: ((level: ReasoningEffort) => void) | undefined
  readonly align?: 'start' | 'end'
  /** 关闭时把焦点还给这里（通常是输入框）；省略时交给 Radix 还到触发按钮。 */
  readonly returnFocus?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const listId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const interactedOutside = useRef(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<ModelRef[]>(() => readRecentModels())
  const [scrollTop, setScrollTop] = useState(0)

  const choices = useMemo(() => enabledModelChoices(providers), [providers])
  const showSearch = choices.length >= MODEL_PICKER_SEARCH_AFTER
  const { full, short } = modelLabels(model, providers)
  /** 触发按钮只显示模型短名；读屏仍用「供应商 · 模型」全名，方便区分同名模型。 */
  const triggerLabel = short ?? t('composer.model.none')
  const a11yLabel = full ?? triggerLabel
  const current = providers
    .find((provider) => provider.id === model?.providerId)
    ?.models.find((item) => item.id === model?.modelId)
  const level = thinkingLevel ?? current?.thinkingLevel ?? 'high'

  // 未显示搜索时忽略残留查询，始终展示完整列表。
  const listQuery = showSearch ? query : ''
  const { rows, options } = useMemo(
    () => buildModelPickerRows(choices, recent, listQuery, t('composer.model.recent')),
    [choices, recent, listQuery, t],
  )
  const offsets = useMemo(() => rowOffsets(rows), [rows])
  const totalHeight = offsets[offsets.length - 1] ?? 0
  const selectedOption = options[Math.min(active, Math.max(0, options.length - 1))]

  const virtualize = rows.length > MODEL_PICKER_VIRTUALIZE_AFTER
  const visible = useMemo(() => {
    if (!virtualize) {
      return rows.map((row, index) => ({ row, index, top: offsets[index]! }))
    }
    const viewport = LIST_MAX_H
    let start = 0
    while (start < rows.length && offsets[start + 1]! <= scrollTop) start += 1
    let end = start
    while (end < rows.length && offsets[end]! < scrollTop + viewport) end += 1
    start = Math.max(0, start - OVERSCAN)
    end = Math.min(rows.length, end + OVERSCAN)
    const slice: { row: ListRow; index: number; top: number }[] = []
    for (let i = start; i < end; i += 1) slice.push({ row: rows[i]!, index: i, top: offsets[i]! })
    return slice
  }, [virtualize, rows, offsets, scrollTop])

  // 打开时：读最近、清空搜索、把高亮落到当前模型；有搜索框则聚焦输入，否则聚焦列表。
  useEffect(() => {
    if (!open) return
    setRecent(readRecentModels())
    setQuery('')
    setScrollTop(0)
    interactedOutside.current = false
    const index = choices.findIndex((choice) => sameModel(choice.ref, model))
    // 初始高亮在下一帧用完整列表算；这里先占位，下面 layout 再校正。
    setActive(index === -1 ? 0 : index)
    const timer = window.setTimeout(() => {
      if (showSearch) searchRef.current?.focus()
      else listRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, showSearch])

  // 搜索词或列表变了：空搜索时尽量停在当前模型；有搜索词时回到第一项。
  useEffect(() => {
    if (!open) return
    if (listQuery.trim() !== '') {
      setActive(0)
      return
    }
    const index = options.findIndex((choice) => sameModel(choice.ref, model))
    setActive(index === -1 ? 0 : index)
  }, [open, listQuery, options, model])

  // 高亮项滚进可视区（虚拟列表同步 scrollTop；短列表用 scrollIntoView）。
  useLayoutEffect(() => {
    if (!open || options.length === 0) return
    const rowIndex = rows.findIndex(
      (row) => row.kind === 'option' && row.optionIndex === Math.min(active, options.length - 1),
    )
    if (rowIndex === -1) return
    const top = offsets[rowIndex]!
    const bottom = top + rowHeight(rows[rowIndex]!)
    if (virtualize) {
      const node = listRef.current
      const viewTop = node?.scrollTop ?? scrollTop
      const viewBottom = viewTop + LIST_MAX_H
      let next = viewTop
      if (top < viewTop) next = top
      else if (bottom > viewBottom) next = Math.max(0, bottom - LIST_MAX_H)
      if (next !== viewTop) {
        if (node) node.scrollTop = next
        setScrollTop(next)
      }
      return
    }
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, options.length, rows, offsets, virtualize])

  const close = (focusBack: boolean) => {
    onOpenChange(false)
    setQuery('')
    if (focusBack && returnFocus !== undefined) returnFocus()
  }

  const choose = (choice: ModelChoice | undefined) => {
    if (choice === undefined) return
    const selected = sameModel(model, choice.ref)
    setRecent(rememberRecentModel(choice.ref))
    close(true)
    if (!selected) onSelect(choice.ref)
  }

  const chooseThinking = (next: ReasoningEffort) => {
    onSelectThinkingLevel?.(next)
    close(true)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (options.length === 0) return
      setActive((index) => {
        const base = Math.min(index, options.length - 1)
        const step = event.key === 'ArrowDown' ? 1 : -1
        return (base + step + options.length) % options.length
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(selectedOption)
    }
  }

  const showThinking = onSelectThinkingLevel !== undefined && current !== undefined
  const activeDescendant =
    selectedOption === undefined ? undefined : `${listId}-${modelRefKey(selectedOption.ref)}`

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) interactedOutside.current = false
        else setQuery('')
        onOpenChange(next)
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={t('composer.model.label', { model: a11yLabel })}
        title={fixed ? t('composer.model.fixedByAgent') : undefined}
        className="flex h-7 max-w-[240px] items-center gap-1 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60 [&_svg]:size-3.5"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="shrink-0 text-faint" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="top"
        sideOffset={6}
        className="flex w-[320px] flex-col gap-0 overflow-hidden rounded-card border border-hair bg-raise p-0 shadow-2"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (showSearch) searchRef.current?.focus()
          else listRef.current?.focus()
        }}
        onInteractOutside={() => {
          interactedOutside.current = true
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus === undefined || interactedOutside.current) return
          event.preventDefault()
          returnFocus()
        }}
      >
        <div className={cn('px-2 pt-2', showSearch ? 'border-b border-hair pb-1.5' : 'pb-1')}>
          <p className="px-1.5 pb-1 text-[11px] font-medium text-faint">
            {t('composer.model.title')}
          </p>
          {showSearch && (
            <label className="flex h-8 items-center gap-2 rounded-[8px] bg-sunk px-2">
              <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onListKeyDown}
                placeholder={t('composer.model.search')}
                role="combobox"
                aria-label={t('composer.model.search')}
                aria-autocomplete="list"
                aria-expanded={true}
                aria-controls={listId}
                aria-activedescendant={activeDescendant}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
              />
            </label>
          )}
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={showSearch ? -1 : 0}
          aria-label={t('composer.model.title')}
          aria-activedescendant={showSearch ? undefined : activeDescendant}
          onKeyDown={showSearch ? undefined : onListKeyDown}
          className="relative overflow-y-auto overscroll-contain px-1.5 py-1 outline-none"
          style={{ maxHeight: LIST_MAX_H }}
          onScroll={(event) => {
            if (virtualize) setScrollTop(event.currentTarget.scrollTop)
          }}
        >
          {options.length === 0 ? (
            <p className="px-2 py-3 text-center text-[12.5px] text-muted">
              {t('composer.model.empty')}
            </p>
          ) : virtualize ? (
            <div style={{ height: totalHeight, position: 'relative' }}>
              {visible.map(({ row, top }) => (
                <div key={row.key} style={{ position: 'absolute', top, left: 0, right: 0 }}>
                  <PickerRow
                    row={row}
                    listId={listId}
                    model={model}
                    activeKey={
                      selectedOption === undefined ? undefined : modelRefKey(selectedOption.ref)
                    }
                    onHover={setActive}
                    onChoose={choose}
                  />
                </div>
              ))}
            </div>
          ) : (
            visible.map(({ row }) => (
              <PickerRow
                key={row.key}
                row={row}
                listId={listId}
                model={model}
                activeKey={
                  selectedOption === undefined ? undefined : modelRefKey(selectedOption.ref)
                }
                onHover={setActive}
                onChoose={choose}
              />
            ))
          )}
        </div>

        {showThinking && (
          <div className="border-t border-hair px-1.5 py-1.5">
            <p className="px-1.5 pb-1 text-[11px] font-medium text-faint">
              {t('composer.thinkingLevel.title')}
            </p>
            {current.supportsReasoning === true ? (
              <div
                role="group"
                aria-label={t('composer.thinkingLevel.title')}
                className="flex flex-col"
              >
                {THINKING_LEVELS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={level === option}
                    onClick={() => chooseThinking(option)}
                    className={cn(
                      'flex h-8 w-full cursor-default items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-fg outline-none hover:bg-hover focus-visible:bg-hover',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {t(`composer.thinkingLevel.${option}`)}
                    </span>
                    {level === option && (
                      <Check aria-hidden className="size-3.5 shrink-0 text-fg" />
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-2 py-1.5 text-[12.5px] text-muted">
                {t('composer.thinkingLevel.unsupported')}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function PickerRow({
  row,
  listId,
  model,
  activeKey,
  onHover,
  onChoose,
}: {
  readonly row: ListRow
  readonly listId: string
  readonly model: ModelRef | undefined
  readonly activeKey: string | undefined
  readonly onHover: (index: number) => void
  readonly onChoose: (choice: ModelChoice) => void
}) {
  if (row.kind === 'header') {
    return (
      <div
        role="presentation"
        className="flex h-[26px] items-center gap-1.5 px-1.5 text-[11px] font-medium text-faint"
        style={{ height: HEADER_H } satisfies CSSProperties}
      >
        {row.protocol !== undefined && (
          <span
            aria-hidden
            className="inline-grid size-3.5 shrink-0 place-items-center text-muted"
            title={row.label}
          >
            <ProviderBrandIcon kind={row.protocol} className="size-3" />
          </span>
        )}
        <span className="truncate">{row.label}</span>
      </div>
    )
  }

  const choice = row.choice
  const selected = sameModel(model, choice.ref)
  const optionKey = modelRefKey(choice.ref)
  const isActive = activeKey === optionKey
  return (
    <div
      id={`${listId}-${optionKey}`}
      role="option"
      aria-selected={selected}
      data-active={isActive}
      onMouseEnter={() => onHover(row.optionIndex)}
      onMouseDown={(event) => {
        event.preventDefault()
        onChoose(choice)
      }}
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2 rounded-[7px] px-2',
        isActive && 'bg-hover',
      )}
      style={{ height: ROW_H }}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{choice.name}</span>
      <ModelMetaChips choice={choice} />
      {selected && <Check aria-hidden className="size-3.5 shrink-0 text-fg" />}
    </div>
  )
}
