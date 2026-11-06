/** 下拉菜单：浮起的卡片（--sh-2），菜单项 7px 圆角、悬停叠加层。 */
import type { ComponentProps } from 'react'
import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import { cn } from './cn.js'

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[180px] rounded-card bg-raise p-1 text-ui text-fg shadow-2 outline-none',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  tone = 'default',
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { readonly tone?: 'default' | 'danger' }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2 rounded-[7px] px-2 outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-muted',
        tone === 'danger' && 'text-danger [&_svg]:text-danger',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label className={cn('px-2 py-1.5 text-note text-muted', className)} {...props} />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('mx-1 my-1 h-px bg-hair', className)} {...props} />
}
