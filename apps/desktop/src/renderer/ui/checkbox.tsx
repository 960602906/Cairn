/** 复选框：批量选择用。保留原生 input，键盘与读屏行为与系统一致。 */
import { useEffect, useRef, type ComponentProps } from 'react'
import { cn } from './cn.js'

export function Checkbox({
  className,
  indeterminate = false,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { readonly indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        'size-3.5 shrink-0 cursor-pointer accent-[var(--accent)] outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-default disabled:opacity-45',
        className,
      )}
      {...props}
    />
  )
}
