/** 开关：打开时强调色底。 */
import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from './cn.js'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-sunk2 p-[2px] shadow-hair2 transition-colors disabled:opacity-45 data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[14px] rounded-full bg-white shadow-1 transition-transform data-[state=checked]:translate-x-[12px]" />
    </SwitchPrimitive.Root>
  )
}
