/**
 * 分段控件（例如主题“跟随系统 / 浅色 / 深色”、diff“合并 / 分栏”）：--sunk2 底，选中项浮起。
 * 语义上是单选组，方向键切换。
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from './cn.js'

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: ReactNode
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T
  readonly options: readonly SegmentedOption<T>[]
  readonly onChange: (value: T) => void
  readonly label: string
  readonly className?: string
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onChange(options[next]!.value)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex gap-0.5 rounded-item bg-sunk2 p-0.5', className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-[6px] px-2.5 text-[12.5px] text-muted transition-colors hover:text-fg [&_svg]:size-3.5',
              selected && 'bg-raise font-medium text-fg shadow-1',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
