/** 列表页的本地筛选框：按输入即时过滤，不发起请求。 */
import { Search } from 'lucide-react'
import { cn } from '../ui/index.js'
import { inputClass } from './Field.js'

export function ListFilter({
  value,
  onChange,
  label,
  placeholder,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly label: string
  readonly placeholder: string
}) {
  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(inputClass, 'pl-8')}
      />
    </label>
  )
}
