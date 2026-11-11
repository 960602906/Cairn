/** 侧栏面板的空状态：居中的小图标加一句说明，不占用视觉重心。 */
import type { ReactNode } from 'react'
import { cn } from './cn.js'

export function PanelEmpty({
  icon,
  hint,
  className,
  children,
}: {
  readonly icon?: ReactNode
  /** 第二行更淡的补充说明。 */
  readonly hint?: ReactNode
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 px-6 pt-16 pb-8 text-center text-note text-muted',
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden
          className="mb-1 grid size-9 place-items-center rounded-[10px] bg-sunk text-faint [&_svg]:size-4"
        >
          {icon}
        </span>
      )}
      <p>{children}</p>
      {hint && <p className="text-faint">{hint}</p>}
    </div>
  )
}
