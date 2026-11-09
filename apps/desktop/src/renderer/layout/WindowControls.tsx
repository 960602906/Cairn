/**
 * Windows / Linux 的窗口按钮（最小化、最大化 / 还原、关闭）。
 *
 * 不用 `titleBarOverlay`：原生按钮会浮在应用弹窗的遮罩之上，主题切换或有弹窗时右上角会露出一块
 * 异色。自绘按钮参与页面层级，颜色完全跟随 `--fg2` / `--hover`，关闭键保持系统红。
 */
import { Minus, Square, X } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/** 顶栏给三个 46px 按钮让出的右侧空间；TopBar 等标题区共用。 */
export const TITLE_BAR_INSET = {
  paddingRight: 'var(--window-controls-inset, 12px)',
} as const

export function WindowControls() {
  const { t } = useTranslation()
  const controls = window.cairn?.windowControls
  const [maximized, setMaximized] = useState(false)

  /** IPC 失败时不要静默：旧主进程没有注册通道时，按钮看起来就像“点了没反应”。 */
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => {
      console.error('[window-controls]', error)
    })
  }

  useEffect(() => {
    if (!controls || controls.platform === 'darwin') return
    let cancelled = false
    let changed = false
    void controls.isMaximized().then((value) => {
      // 初始查询可能比最大化事件晚返回，不能把刚收到的新状态覆盖掉。
      if (!cancelled && !changed) setMaximized(value)
    })
    const off = controls.onMaximizedChange((value) => {
      changed = true
      setMaximized(value)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [controls])

  if (!controls || controls.platform === 'darwin') return null

  return (
    <div
      className="no-drag pointer-events-auto fixed top-0 right-0 z-[1000] flex h-12 items-stretch"
      // 自绘按钮压在顶栏拖拽区上，显式声明不接受窗口拖动，避免被系统拖拽吞掉点击。
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <ControlButton label={t('window.minimize')} onClick={() => run(controls.minimize)}>
        <Minus />
      </ControlButton>
      <ControlButton
        label={maximized ? t('window.restore') : t('window.maximize')}
        onClick={() => run(controls.toggleMaximize)}
      >
        {maximized ? <RestoreGlyph /> : <Square />}
      </ControlButton>
      <ControlButton label={t('window.close')} danger onClick={() => run(controls.close)}>
        <X />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  readonly label: string
  readonly danger?: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`flex w-[46px] items-center justify-center text-fg2 transition-colors [&_svg]:size-3.5 ${
        danger
          ? 'hover:bg-[#c42b1c] hover:text-white active:bg-[#b0281a]'
          : 'hover:bg-hover hover:text-fg active:bg-sunk2'
      }`}
    >
      {children}
    </button>
  )
}

/** 还原图标：两个错开的方框，和 Windows 的还原按钮一致。 */
function RestoreGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      className="size-3.5"
    >
      <rect x="4.25" y="2.25" width="7.5" height="7.5" rx="0.5" />
      <path d="M2.25 4.25h1.9M2.25 4.25v7.5h7.5v-1.9" />
    </svg>
  )
}
