/** 快捷键提示（例如 Ctrl+N、Esc）。 */
import type { HTMLAttributes } from 'react'
import { cn } from './cn.js'

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-sunk px-1 font-mono text-[11px] text-muted shadow-hair2',
        className,
      )}
      {...props}
    />
  )
}
