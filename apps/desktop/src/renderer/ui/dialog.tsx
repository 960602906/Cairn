/**
 * 对话框（视觉规范 §5、§6）：模糊遮罩、圆角 18px、阴影 --sh-3；Esc 与点击遮罩关闭。
 * 危险操作确认框（tone="danger"）左上角是红色图标，按钮写明动作和数量。
 */
import type { ComponentProps, ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from './cn.js'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  className,
  children,
  icon,
  tone = 'default',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** 标题左上方的图标。 */
  readonly icon?: ReactNode
  readonly tone?: 'default' | 'danger'
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgba(10,10,14,.28)] backdrop-blur-[3px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-dialog bg-raise p-6 text-fg shadow-3 outline-none',
          className,
        )}
        {...props}
      >
        {icon && (
          <div
            className={cn(
              'mb-4 inline-flex size-9 items-center justify-center rounded-[10px] [&_svg]:size-[18px]',
              tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-sunk text-fg2',
            )}
          >
            {icon}
          </div>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-dialog text-fg', className)} {...props} />
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('mt-2 text-[14px] leading-relaxed text-fg2', className)}
      {...props}
    />
  )
}

/** 底部按钮行：两个等宽按钮，取消在左、主按钮在右。 */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('mt-6 grid auto-cols-fr grid-flow-col gap-2.5', className)} {...props} />
  )
}
