/**
 * Cairn 品牌图形（第 8 轮识别系统）。
 *
 * 「环石 C」：一圈开口的环，缺口里放一颗小石。既是字母 C，也像石标。
 * 产品内与应用图标使用同一枚记号，避免两个符号打架。
 */
import type { ReactNode } from 'react'
import { cn } from './cn.js'

/** 24×24 栅格的环石 C：开口朝右，缺口里一颗石。 */
const HALO_C = 'M17.2 7.4A6.8 6.8 0 1 0 17.2 16.6'

function Svg({
  size,
  label,
  className,
  children,
}: {
  readonly size: number
  readonly label?: string
  readonly className?: string | undefined
  readonly children: ReactNode
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      focusable="false"
      className={cn('shrink-0', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {children}
    </svg>
  )
}

export function CairnMark({
  size = 24,
  label,
  className,
}: {
  readonly size?: number
  /** 有名称时作为图片暴露给读屏；装饰性使用时省略。 */
  readonly label?: string
  readonly className?: string
}) {
  return (
    <Svg size={size} className={className} {...(label === undefined ? {} : { label })}>
      <path
        d={HALO_C}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <circle cx={19.6} cy={12} r={1.9} fill="currentColor" />
    </Svg>
  )
}

/** 应用图标：环石 C。 */
export function CairnAppMark({
  size = 24,
  label,
  className,
}: {
  readonly size?: number
  readonly label?: string
  readonly className?: string
}) {
  return (
    <Svg size={size} className={className} {...(label === undefined ? {} : { label })}>
      <path
        d={HALO_C}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <circle cx={19.6} cy={12} r={1.9} fill="currentColor" />
    </Svg>
  )
}
