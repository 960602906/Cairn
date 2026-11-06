/**
 * 按钮（视觉规范 §5）：主按钮近黑底（--ink），次按钮浮起底加发丝描边，幽灵按钮只有悬停层，危险按钮红底。
 * 圆角 8px，悬停与按下用叠加层，150ms 过渡。
 */
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { Slot } from 'radix-ui'
import { cn } from './cn.js'

export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-item text-ui font-medium transition-[background-color,box-shadow,color,opacity] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-ink text-ink-fg hover:opacity-90 active:opacity-80',
        secondary: 'bg-raise text-fg shadow-1 hover:bg-sunk active:bg-sunk2',
        ghost: 'text-fg2 hover:bg-hover hover:text-fg active:bg-press',
        danger: 'bg-danger text-white hover:opacity-90 active:opacity-80',
      },
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-8 px-3',
        lg: 'h-10 px-4 text-[14px]',
        icon: 'size-8',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** 把样式交给唯一的子元素（例如链接），不渲染 <button>。 */
  readonly asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  )
}

/** 只有图标的按钮必须给出 label（读屏与悬停提示）。 */
export function IconButton({
  label,
  size = 'icon',
  variant = 'ghost',
  ...props
}: Omit<ButtonProps, 'aria-label'> & { readonly label: string }) {
  return <Button aria-label={label} title={label} size={size} variant={variant} {...props} />
}
