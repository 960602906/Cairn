/**
 * Agent 图标（M3-12，管理界面 §3.2）：分类色底 + 图标；内置编程助手用代码图标。
 * 颜色只接受设计令牌里的分类名，未知名字按 accent 处理。
 */
import { Bot, Braces, Bug, Code, Globe, ShieldCheck, Sparkles } from 'lucide-react'
import { cn } from '../ui/index.js'

const ICONS = {
  code: Code,
  bot: Bot,
  braces: Braces,
  bug: Bug,
  globe: Globe,
  shield: ShieldCheck,
  sparkles: Sparkles,
} as const

const COLORS: Readonly<Record<string, string>> = {
  'agent-blue': 'bg-accent-soft text-accent',
  'agent-green': 'bg-ok-soft text-ok',
  'agent-amber': 'bg-warn-soft text-warn',
  'agent-red': 'bg-danger-soft text-danger',
}

export function AgentAvatar({
  icon,
  color,
  size = 32,
  className,
}: {
  readonly icon?: string | undefined
  readonly color?: string | undefined
  readonly size?: number
  readonly className?: string
}) {
  const Icon = (icon && ICONS[icon as keyof typeof ICONS]) || Bot
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[10px]',
        COLORS[color ?? 'agent-blue'] ?? COLORS['agent-blue'],
        className,
      )}
    >
      <Icon style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} />
    </span>
  )
}

export const AGENT_ICON_NAMES = Object.keys(ICONS)
export const AGENT_COLOR_NAMES = Object.keys(COLORS)
