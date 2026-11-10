/**
 * `/` 命令面板的纯逻辑：解析草稿、过滤命令。
 *
 * 面板只在草稿以 `/` 开头、且还没有输入空白时打开；`/foo bar` 已经进入
 * 普通消息，避免把带参数的文本误当成命令。命令执行由 Composer 负责。
 */

export type ComposerCommandId = 'compact' | 'plan' | 'model'

export interface ComposerCommandDefinition {
  readonly id: ComposerCommandId
  /** 不含斜杠的命令名。 */
  readonly name: string
  /** 描述的 i18n key；过滤时使用同一份译文。 */
  readonly descriptionKey: string
}

export const COMPOSER_COMMANDS: readonly ComposerCommandDefinition[] = [
  { id: 'compact', name: 'compact', descriptionKey: 'composer.command.compact.hint' },
  { id: 'plan', name: 'plan', descriptionKey: 'composer.command.plan.hint' },
  { id: 'model', name: 'model', descriptionKey: 'composer.command.model.hint' },
]

/**
 * 草稿处于 `/` 命令输入状态时返回查询串（不含斜杠），否则返回 null。
 * 只认一个 token：出现空白就说明用户已经在写普通消息。
 */
export function composerCommandQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const query = draft.slice(1)
  return /^\S*$/.test(query) ? query : null
}

export interface FilterableComposerCommand {
  readonly name: string
  readonly description: string
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
    const name = command.name.toLowerCase()
    const description = command.description.toLowerCase()
    const rank = name.startsWith(normalized)
      ? 0
      : name.includes(normalized)
        ? 1
        : description.includes(normalized)
          ? 2
          : -1
    if (rank >= 0) ranked.push({ command, rank, index })
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.command)
}
