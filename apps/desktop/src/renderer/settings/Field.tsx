/** 设置页的卡片与表单行（M2-09、M2-10，视觉规范 §8）。 */
import type { ReactNode } from 'react'
import { cn } from '../ui/index.js'

/** 设置页的卡片：浮起的白底，0.5px 描边。 */
export function SettingsCard({
  className,
  children,
  ...rest
}: {
  readonly className?: string
  readonly children: ReactNode
  readonly 'aria-label'?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-5 rounded-card bg-raise px-5 pt-5 pb-5 shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)]',
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  )
}

/** 一行设置：左侧标签（132px），右侧控件，下面可以有说明。 */
export function Field({
  label,
  labelFor,
  hint,
  children,
}: {
  readonly label: string
  /** 控件是表单元素时给出它的 id；否则标签只是文字，控件自己带 aria-label。 */
  readonly labelFor?: string
  readonly hint?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[148px_minmax(0,1fr)] items-start gap-x-6 gap-y-2 max-[640px]:grid-cols-1">
      {labelFor ? (
        <label htmlFor={labelFor} className="pt-1 text-[13px] text-fg2 max-[640px]:pt-0">
          {label}
        </label>
      ) : (
        <span className="pt-1 text-[13px] text-fg2 max-[640px]:pt-0">{label}</span>
      )}
      <div className="min-w-0">{children}</div>
      {hint && <p className="-mt-0.5 text-note text-muted min-[641px]:col-start-2">{hint}</p>}
    </div>
  )
}

/** 单行输入框（视觉规范 §8）：纸面底，0.5px 描边，聚焦时强调色。 */
export const inputClass =
  'block h-9 w-full min-w-0 rounded-[9px] bg-paper px-2.5 text-[13.5px] text-fg shadow-[inset_0_0_0_0.5px_var(--hair2)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] disabled:opacity-60 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger)]'

/** 带标题与说明的设置分组卡片：图标 + 标题，下面是一组相关设置。 */
export function SettingsGroup({
  icon,
  title,
  description,
  children,
  className,
}: {
  readonly icon?: ReactNode
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <SettingsCard className={cn('gap-4', className)}>
      <div className="flex items-start gap-3">
        {icon && (
          <span
            aria-hidden
            className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[8px] bg-sunk text-fg2 shadow-hair [&_svg]:size-4"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-[-0.005em] text-fg">{title}</h3>
          {description && (
            <p className="mt-0.5 text-note leading-relaxed text-muted">{description}</p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </SettingsCard>
  )
}

/** 左侧标题与说明、右侧开关的一行设置。 */
export function ToggleRow({
  title,
  hint,
  children,
}: {
  readonly title: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-ui text-fg">{title}</p>
        {hint && <p className="mt-0.5 text-note leading-relaxed text-muted">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

/** 空状态：图标、标题、说明与可选操作，居中放在卡片里。 */
export function SettingsEmpty({
  icon,
  title,
  description,
  action,
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly description: string
  readonly action?: ReactNode
}) {
  return (
    <SettingsCard className="items-center gap-3 px-6 py-10 text-center">
      <span
        aria-hidden
        className="grid size-11 place-items-center rounded-[13px] bg-sunk text-muted shadow-hair [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="max-w-[46ch]">
        <p className="text-ui font-medium text-fg">{title}</p>
        <p className="mt-1 text-note leading-relaxed text-muted">{description}</p>
      </div>
      {action && <div className="pt-1">{action}</div>}
    </SettingsCard>
  )
}
