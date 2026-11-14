/**
 * `/` 指令的注册表与纯逻辑：解析草稿、过滤指令、匹配参数。
 *
 * 指令只认消息开头。菜单只在草稿是一个 `/` 开头的词（还没有空白）时打开；
 * 写了空白之后菜单收起，`/名称 参数` 在发送时由 `parseComposerCommand` 识别。
 * 名称不在表里的 `/xxx` 按普通消息发送。指令的执行由 Composer 负责。
 */
import type { SessionPanel } from './SessionPanels.js'
import type { SettingsSection } from './settings/SettingsPage.js'

export type ComposerCommandId =
  'compact' | 'plan' | 'model' | 'new' | 'undo' | 'files' | 'diff' | 'brief' | 'settings'

/** 指令后面能跟什么：没有参数、一段任务描述、模型名、设置分区名。 */
export type ComposerCommandArgs = 'none' | 'text' | 'model' | 'settings'

export interface ComposerCommandDefinition {
  readonly id: ComposerCommandId
  /** 不含斜杠的指令名。 */
  readonly name: string
  /** 描述的 i18n key；过滤时使用同一份译文。 */
  readonly descriptionKey: string
  readonly args: ComposerCommandArgs
  /** 运行中不能执行。 */
  readonly idleOnly?: boolean
  /** 执行时打开的右侧面板。 */
  readonly panel?: SessionPanel
}

export const COMPOSER_COMMANDS: readonly ComposerCommandDefinition[] = [
  { id: 'plan', name: 'plan', descriptionKey: 'composer.command.plan.hint', args: 'text' },
  { id: 'model', name: 'model', descriptionKey: 'composer.command.model.hint', args: 'model' },
  {
    id: 'compact',
    name: 'compact',
    descriptionKey: 'composer.command.compact.hint',
    args: 'none',
    idleOnly: true,
  },
  {
    id: 'undo',
    name: 'undo',
    descriptionKey: 'composer.command.undo.hint',
    args: 'none',
    idleOnly: true,
  },
  { id: 'new', name: 'new', descriptionKey: 'composer.command.new.hint', args: 'none' },
  {
    id: 'files',
    name: 'files',
    descriptionKey: 'composer.command.files.hint',
    args: 'none',
    panel: 'files',
  },
  {
    id: 'diff',
    name: 'diff',
    descriptionKey: 'composer.command.diff.hint',
    args: 'none',
    panel: 'diff',
  },
  {
    id: 'brief',
    name: 'brief',
    descriptionKey: 'composer.command.brief.hint',
    args: 'none',
    panel: 'brief',
  },
  {
    id: 'settings',
    name: 'settings',
    descriptionKey: 'composer.command.settings.hint',
    args: 'settings',
  },
]

/**
 * 草稿处于 `/` 指令输入状态时返回查询串（不含斜杠），否则返回 null。
 * 只认一个词：出现空白就说明用户在写参数或普通消息。
 */
export function composerCommandQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const query = draft.slice(1)
  return /^\S*$/.test(query) ? query : null
}

export interface ParsedComposerCommand<T extends { readonly name: string }> {
  readonly command: T
  /** 指令名后面的文字，去掉首尾空白；没有时为空串。 */
  readonly args: string
}

/**
 * 识别开头的 `/名称 参数`。名称不在表里、或指令不收参数却写了参数时返回 undefined，
 * 草稿按普通消息发送。
 */
export function parseComposerCommand<T extends { readonly name: string; readonly args: string }>(
  draft: string,
  commands: readonly T[],
): ParsedComposerCommand<T> | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim())
  if (match === null) return undefined
  const command = commands.find((item) => item.name === match[1])
  if (command === undefined) return undefined
  const args = (match[2] ?? '').trim()
  if (args !== '' && command.args === 'none') return undefined
  return { command, args }
}

export interface FilterableComposerCommand {
  readonly name: string
  readonly description: string
}

/** 按名称前缀、名称包含、描述包含排序，返回名次；不匹配返回 -1。 */
function rankText(name: string, description: string, query: string): number {
  const n = name.toLowerCase()
  if (n.startsWith(query)) return 0
  if (n.includes(query)) return 1
  return description.toLowerCase().includes(query) ? 2 : -1
}

/**
 * 按名称前缀、名称包含、描述包含依次排序；空查询保持注册表顺序。
 * 返回新数组，调用方可以安全截断或重排。
 */
export function filterComposerCommands<T extends FilterableComposerCommand>(
  commands: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase()
  if (normalized === '') return [...commands]
  const ranked: { command: T; rank: number; index: number }[] = []
  commands.forEach((command, index) => {
    const rank = rankText(command.name, command.description, normalized)
    if (rank >= 0) ranked.push({ command, rank, index })
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.command)
}

/**
 * 在候选里找参数指的那一个：名称完全相同优先，其次是唯一的前缀匹配，再次是唯一的包含匹配。
 * 有歧义或找不到时返回 undefined。比较时忽略大小写和空白。
 */
export function matchCommandArg<T>(
  query: string,
  items: readonly T[],
  names: (item: T) => readonly string[],
): T | undefined {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, '')
  const q = normalize(query)
  if (q === '') return undefined
  const keys = items.map((item) => names(item).map(normalize))
  for (const test of [
    (key: string) => key === q,
    (key: string) => key.startsWith(q),
    (key: string) => key.includes(q),
  ]) {
    const hits = items.filter((_, index) => keys[index]!.some(test))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return undefined
  }
  return undefined
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'archived',
  'providers',
  'skills',
  'mcp',
  'permissions',
  'update',
  'about',
]
