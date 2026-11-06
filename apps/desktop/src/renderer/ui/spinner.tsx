/** 运行中的小转圈与流光文字（视觉规范 §5、§6）；减少动态效果时由全局样式停掉动画。 */
import type { HTMLAttributes } from 'react'
import { cn } from './cn.js'

export function Spinner({
  className,
  label,
}: {
  readonly className?: string
  readonly label?: string
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent text-accent',
        className,
      )}
    />
  )
}

/** 正在进行的步骤：文字上有一道流光。 */
export function Shimmer({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'animate-shimmer bg-[linear-gradient(90deg,var(--muted)_0%,var(--muted)_40%,var(--fg)_50%,var(--muted)_60%,var(--muted)_100%)] bg-size-[200%_100%] bg-clip-text text-transparent',
        className,
      )}
      {...props}
    />
  )
}
