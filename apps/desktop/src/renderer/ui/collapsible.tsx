/**
 * 折叠容器（M2-01 基础组件）：shadcn/ui 的做法，以 Radix Collapsible 为底座。
 *
 * 展开用 Radix 暴露的 `--radix-collapsible-content-height` 做真实高度过渡；收起直接归零
 * （高度过渡无法在 `h-0` 状态下正确测量，强行做会有跳变），所以收起是瞬时的。
 * 需要保留 DOM（例如按文本查找、流式内容）时给 Content 传 `forceMount`，收起状态用 `h-0` 收住。
 * `prefers-reduced-motion` 由 index.css 的全局规则把动画时长归零。
 */
import type { ComponentProps } from 'react'
import { Collapsible as CollapsiblePrimitive } from 'radix-ui'
import { cn } from './cn.js'

export const Collapsible = CollapsiblePrimitive.Root
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger

export function CollapsibleContent({
  className,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return (
    <CollapsiblePrimitive.Content
      className={cn(
        'overflow-hidden data-[state=closed]:h-0 data-[state=open]:animate-collapsible-down',
        className,
      )}
      {...props}
    />
  )
}
