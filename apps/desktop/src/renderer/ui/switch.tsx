/**
 * 开关：安静的发丝描边轨道；打开时用软底 + 深色滑块，避免浅色主题下
 * `--accent`（近黑）铺满整颗胶囊造成的廉价 iOS 观感。
 */
import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from './cn.js'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[15px] w-[26px] shrink-0 items-center rounded-full bg-sunk p-px shadow-[inset_0_0_0_0.5px_var(--hair2)] transition-[background-color,box-shadow] disabled:opacity-45',
        'data-[state=checked]:bg-accent-soft data-[state=checked]:shadow-[inset_0_0_0_1px_var(--fg2)]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-[13px] rounded-full bg-paper shadow-1 transition-[transform,background-color]',
          'data-[state=checked]:translate-x-[11px] data-[state=checked]:bg-fg',
        )}
      />
    </SwitchPrimitive.Root>
  )
}
