/** 悬停提示：近黑底小气泡。应用根部需要一个 TooltipProvider。 */
import type { ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={400}>{children}</TooltipPrimitive.Provider>
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  readonly content: ReactNode
  readonly children: ReactNode
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-[6px] bg-ink px-2 py-1 text-[12px] text-ink-fg shadow-2"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
