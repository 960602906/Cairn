/** Cairn 品牌图形：三块叠石，来源与应用图标一致（build/icons/glyph.svg）。 */
import { cn } from './cn.js'

const STONES = [
  'M12 75.5C12 67.5 29 62.5 50 62.5S88 66.5 88 74.5C88 82.5 71 87.5 50 87.5S12 83.5 12 75.5Z',
  'M24 51.5C24 44.5 35.5 39.5 50 39.5S76 43.5 76 50.5C76 57 64.5 60.5 50 60.5S24 58 24 51.5Z',
  'M38 29C38 22.5 44 18 52 18S66 22 66 28C66 34 60 37.5 52 37.5S38 35 38 29Z',
] as const

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
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      focusable="false"
      className={cn('shrink-0 fill-current', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <path d={STONES[0]} />
      <g transform="rotate(-5 50 51)">
        <path d={STONES[1]} />
      </g>
      <g transform="rotate(7 52 28)">
        <path d={STONES[2]} />
      </g>
    </svg>
  )
}
