/**
 * 输入框上方悬浮卡片的外壳。提问、计划操作、记忆提议、待办进度、目标条都从这里取表面样式，
 * 改圆角、底色、阴影或内边距时只改这一处。
 *
 * - `card`：有正文的决策卡，自带内边距。
 * - `bar`：单行细条，高度由里面的一行决定，并在输入框上方留出间距。
 */
import type { ComponentPropsWithRef } from 'react'
import { cn } from './cn.js'

const surface = 'rounded-approval bg-raise shadow-2'

export const floatCardVariants = {
  card: `${surface} px-3 py-2.5`,
  bar: `${surface} mb-2 overflow-hidden`,
} as const

export type FloatCardVariant = keyof typeof floatCardVariants

/** 卡片右上角的小标记（可多选、记忆范围）。 */
export const floatChipClass =
  'shrink-0 rounded-full bg-sunk px-1.5 text-[11.5px] leading-5 text-muted'

type Tag = 'article' | 'section'

type FloatCardProps = {
  readonly as?: Tag
  readonly variant?: FloatCardVariant
} & Omit<ComponentPropsWithRef<'section'>, 'as'> & {
    readonly [key: `data-${string}`]: string | number | undefined
  }

export function FloatCard({
  as: Tag = 'section',
  variant = 'card',
  className,
  ...props
}: FloatCardProps) {
  return <Tag className={cn(floatCardVariants[variant], className)} {...props} />
}
