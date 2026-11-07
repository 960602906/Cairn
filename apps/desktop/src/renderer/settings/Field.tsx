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
        'flex flex-col gap-5 rounded-approval bg-raise px-5 pt-4.5 pb-5 shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)]',
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
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-x-4 gap-y-2 max-[640px]:grid-cols-1">
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

/** 单行输入框（视觉规范 §8）：纸面底，1px 描边，聚焦时强调色。 */
export const inputClass =
  'block h-[34px] w-full min-w-0 rounded-[9px] bg-paper px-2.5 text-[13.5px] text-fg shadow-[inset_0_0_0_1px_var(--hair2)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] disabled:opacity-60 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger)]'
