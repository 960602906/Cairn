/**
 * 右侧会话信息栏：只负责标签栏、宽度与浮层行为；每个面板的内容都在 `SessionPanels.tsx`。
 *
 * 首页是一排紧凑入口，点卡片在标签栏打开完整页面。面板注册表集中管理标签与「+」菜单，
 * 「+」菜单只列 `addable` 的固定入口；改动、计划等从对话里打开。
 *
 * 视觉上它是对话纸面的延伸：和对话同一底色，只用一条发丝线分开，标签是一排安静的胶囊，
 * 不再有单独的标题栏和底色。常驻时由顶栏按钮开合，所以只在浮层模式下显示关闭按钮。
 */
import { House, Plus, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import type { SessionStatus } from '@cairn/protocol'
import { ResizeHandle, useResizableWidth } from './layout/resize.js'
import { SessionHome } from './SessionHome.js'
import {
  SESSION_PANEL_DEFINITIONS,
  SessionPanelContent,
  type SessionPanel,
  type SessionPanelView,
} from './SessionPanels.js'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from './ui/index.js'

export { SESSION_PANELS, type SessionPanel, type SessionPanelView } from './SessionPanels.js'

export function SessionSidePanel({
  sessionId,
  view,
  status,
  panel,
  selectedPlanId,
  selectedChangeSetId,
  onSelectChangeSet,
  onOpenPanel,
  onActivateTab,
  onHome,
  tabs,
  onCloseTab,
  open = true,
  placement = 'side',
  docked = false,
  onClose,
  onLocateTurn,
  onOpenActivitySession,
}: {
  readonly sessionId: string
  readonly view: SessionView | undefined
  readonly status: SessionStatus
  readonly panel: SessionPanelView
  readonly selectedPlanId: string | undefined
  /** 从委派卡片、活动中心或检查器打开的改动集。 */
  readonly selectedChangeSetId?: string | undefined
  readonly onSelectChangeSet?: ((changeSetId: string | undefined) => void) | undefined
  /** 打开或切换到某个面板；首页卡片和「+」菜单使用，会回到该面板的概览状态。 */
  readonly onOpenPanel: (panel: SessionPanel) => void
  /** 点击已打开的标签；保留当前选中项，不重置概览状态。 */
  readonly onActivateTab: (panel: SessionPanel) => void
  readonly onHome: () => void
  /** 已打开的标签；标签栏按这个顺序显示。 */
  readonly tabs: readonly SessionPanel[]
  readonly onCloseTab: (panel: SessionPanel) => void
  /** 由顶栏按钮控制；窄窗口为浮层，宽窗口占用布局宽度。 */
  readonly open?: boolean
  /** 叠层布局把工作台放在对话下方；`side` 保持原有的右侧浮层/侧栏。 */
  readonly placement?: 'side' | 'bottom'
  /** 宽屏时占用布局宽度；窄屏时作为右侧浮层。 */
  readonly docked?: boolean
  readonly onClose?: () => void
  /** 从运行树定位到对话轮次。 */
  readonly onLocateTurn?: ((runId: string, turnId: string) => void) | undefined
  /** 活动中心面板里打开其他会话。 */
  readonly onOpenActivitySession?: ((sessionId: string, changeSetId?: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const bottom = placement === 'bottom'
  const addablePanels = SESSION_PANEL_DEFINITIONS.filter((item) => item.addable)
  const availablePanels = addablePanels.filter(({ id }) => !tabs.includes(id))
  const panelRef = useRef<HTMLElement>(null)
  const { width, dragging, handleProps } = useResizableWidth({
    storageKey: 'cairn.sessionPanelWidth',
    initial: 348,
    min: 300,
    max: 720,
    edge: 'left',
  })
  // 浮层模式是模态的：把焦点收进面板，Tab 在面板内循环，关闭后还给原控件。
  useEffect(() => {
    if (!open || docked) return
    const panel = panelRef.current
    if (!panel) return
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const focusable = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getAttribute('aria-hidden') !== 'true')
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      if (
        document.querySelector(
          '[role="menu"], [role="listbox"], [role="dialog"]:not([data-side-panel-dialog]):not([aria-hidden="true"])',
        )
      )
        return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? index <= 0
          ? items.length - 1
          : index - 1
        : index === items.length - 1
          ? 0
          : index + 1
      event.preventDefault()
      items[next]?.focus()
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [docked, open])
  return (
    <aside
      ref={panelRef}
      id="session-side-panel"
      role={docked ? 'complementary' : 'dialog'}
      aria-label={t('sidePanel.label')}
      aria-modal={docked ? undefined : true}
      aria-hidden={!open}
      inert={!open}
      data-side-panel-dialog={docked ? undefined : ''}
      style={bottom ? undefined : { width: open ? width : 0 }}
      className={cn(
        'flex shrink-0 flex-col bg-paper',
        bottom
          ? 'relative h-full min-h-0 w-full overflow-hidden border-t-[0.5px] border-hair'
          : cn(
              docked
                ? 'relative z-auto border-l-[0.5px] border-hair'
                : 'absolute inset-y-0 right-0 z-20 max-w-full shadow-3',
              !dragging &&
                'transition-[width,transform,opacity] duration-200 ease-out motion-reduce:transition-none',
              open
                ? 'translate-x-0 opacity-100'
                : 'pointer-events-none translate-x-full overflow-hidden opacity-0',
            ),
      )}
    >
      {open && !bottom && <ResizeHandle label={t('sidePanel.resize')} {...handleProps} />}
      <div
        style={bottom ? undefined : { width }}
        className={cn(
          'flex h-full max-w-full shrink-0 flex-col overflow-hidden',
          bottom && 'w-full',
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-2">
          <div
            role="tablist"
            aria-label={t('sidePanel.tabs')}
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <button
              type="button"
              role="tab"
              aria-label={t('sidePanel.home')}
              aria-selected={panel === 'home'}
              onClick={onHome}
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-item outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent',
                panel === 'home' ? 'bg-sunk text-fg' : 'text-muted hover:bg-hover hover:text-fg2',
              )}
            >
              <House aria-hidden className="size-3.5" />
            </button>
            {tabs.map((id) => {
              const definition = SESSION_PANEL_DEFINITIONS.find((item) => item.id === id)
              const short = definition?.shortLabel ?? 'sidePanel.diff'
              const full = definition?.label ?? 'sidePanel.diff'
              const selected = panel === id
              return (
                <div
                  key={id}
                  className={cn(
                    'group/tab flex h-7 min-w-0 shrink-0 items-center rounded-item transition-colors',
                    selected ? 'bg-sunk text-fg' : 'text-muted hover:bg-hover hover:text-fg2',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t(full)}
                    aria-selected={selected}
                    onClick={() => onActivateTab(id)}
                    className={cn(
                      'flex h-7 min-w-0 items-center rounded-item pr-1 pl-2.5 text-note outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      selected && 'font-medium',
                    )}
                  >
                    <span className="max-w-[72px] truncate">{t(short)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('sidePanel.closeTab', { name: t(full) })}
                    onClick={() => onCloseTab(id)}
                    className={cn(
                      'mr-1 grid size-4 shrink-0 place-items-center rounded-[4px] text-faint outline-none transition-opacity hover:bg-press hover:text-fg focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent',
                      selected ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
                    )}
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
          {availablePanels.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t('sidePanel.addTab')} size="icon-sm">
                  <Plus />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[140px]">
                {availablePanels.map(({ id, shortLabel }) => (
                  <DropdownMenuItem key={id} onSelect={() => onOpenPanel(id)}>
                    {t(shortLabel)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onClose && !docked && (
            <IconButton label={t('sidePanel.close')} size="icon-sm" onClick={onClose}>
              <X />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {panel === 'home' ? (
            <SessionHome
              view={view}
              status={status}
              onOpenFiles={() => onOpenPanel('files')}
              onOpenInspector={() => onOpenPanel('inspector')}
            />
          ) : (
            <SessionPanelContent
              panel={panel}
              sessionId={sessionId}
              view={view}
              status={status}
              selectedPlanId={selectedPlanId}
              selectedChangeSetId={selectedChangeSetId}
              onOpenPanel={onOpenPanel}
              {...(onSelectChangeSet === undefined ? {} : { onSelectChangeSet })}
              {...(onLocateTurn === undefined ? {} : { onLocateTurn })}
              {...(onOpenActivitySession === undefined ? {} : { onOpenActivitySession })}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
