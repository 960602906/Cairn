/**
 * 记忆注入系统提示词（M7-02，Runtime §22、ADR-0019）。
 *
 * 只处理已经选出的条目：范围过滤与 `active` 过滤在查询层完成（跨项目条目根本读不到），这里负责
 * 固定顺序、去重、按独立上限裁剪。三个范围的顺序是会话 → 项目 → 全局：越靠近当前工作的记忆越靠前，
 * 被裁剪时也是越久没更新的越先离开。
 *
 * 与 `AGENTS.md` 的区别：项目说明是用户维护的固定上下文，记忆是运行中积累的内容，两者分开管理，
 * 记忆排在项目说明之后（见 `system-prompt.ts`）。
 */
import type { MemoryScope } from '@cairn/protocol'

/**
 * 记忆正文的独立上限（字节）。与 `AGENTS.md` 的 32 KB 分开计算：记忆可能很长，而且会随确认不断增长，
 * 不能挤占项目说明与对话历史的预算。
 */
export const MEMORY_CONTEXT_MAX_BYTES = 4 * 1024

/** 范围的固定顺序：会话 → 项目 → 全局。 */
export const MEMORY_SCOPE_ORDER: readonly MemoryScope[] = ['session', 'project', 'global']

const SCOPE_TITLES: Readonly<Record<MemoryScope, string>> = {
  session: 'Session',
  project: 'Project',
  global: 'Global',
}

export interface MemoryContextEntry {
  readonly scope: MemoryScope
  readonly content: string
  /** 裁剪依据：上限不够时先去掉最久没有更新的条目。 */
  readonly updatedAt: number
}

export interface MemoryContextOptions {
  readonly maxBytes?: number
}

export interface MemoryContext {
  /** 放进提示词的正文（含 `## 范围` 子标题）；没有可用条目时没有 `text`。 */
  readonly text?: string
  /** 真正纳入的条目数。 */
  readonly included: number
  /** 因为上限被去掉的条目数。 */
  readonly dropped: number
  readonly truncated: boolean
  /** 正文的 UTF-8 字节数。 */
  readonly bytes: number
}

/** UTF-8 字节数（不依赖 Buffer / TextEncoder）。 */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：两个 UTF-16 单元合成一个 4 字节码点。
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** 去重与判空都用折叠空白后的内容：同一条记忆在两个范围里只出现一次。 */
const normalize = (content: string): string => content.trim().replace(/\s+/g, ' ')

const scopeRank = (scope: MemoryScope): number => {
  const rank = MEMORY_SCOPE_ORDER.indexOf(scope)
  return rank === -1 ? MEMORY_SCOPE_ORDER.length : rank
}

const bullet = (content: string): string => `- ${content.trim()}`

/**
 * 组装记忆正文。顺序固定为会话 → 项目 → 全局；同一内容只在最靠前的范围保留一次；
 * 超过上限时按 `updatedAt` 从旧到新去掉，并在正文末尾注明去掉了多少条。
 */
export function buildMemoryContext(
  entries: readonly MemoryContextEntry[],
  options: MemoryContextOptions = {},
): MemoryContext {
  const maxBytes = options.maxBytes ?? MEMORY_CONTEXT_MAX_BYTES
  const seen = new Set<string>()
  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => normalize(entry.content) !== '')
    .sort((a, b) => scopeRank(a.entry.scope) - scopeRank(b.entry.scope) || a.index - b.index)
    .filter(({ entry }) => {
      const key = normalize(entry.content)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  if (candidates.length === 0) {
    return { included: 0, dropped: 0, truncated: false, bytes: 0 }
  }

  // 先按更新时间从新到旧挑能放下的条目，再按范围顺序输出。
  const headingBytes = (scope: MemoryScope) => utf8Length(`## ${SCOPE_TITLES[scope] ?? scope}\n`)
  const selected = new Set<number>()
  const scopes = new Set<MemoryScope>()
  let bytes = 0
  for (const { entry, index } of [...candidates].sort(
    (a, b) => b.entry.updatedAt - a.entry.updatedAt || a.index - b.index,
  )) {
    const cost =
      utf8Length(`${bullet(entry.content)}\n`) +
      (scopes.has(entry.scope) ? 0 : headingBytes(entry.scope))
    if (bytes + cost > maxBytes) continue
    selected.add(index)
    scopes.add(entry.scope)
    bytes += cost
  }

  const chosen = candidates.filter(({ index }) => selected.has(index))
  const dropped = candidates.length - chosen.length
  if (chosen.length === 0) {
    return {
      included: 0,
      dropped,
      truncated: dropped > 0,
      bytes: 0,
    }
  }

  const groups = MEMORY_SCOPE_ORDER.map((scope) => {
    const items = chosen.filter(({ entry }) => entry.scope === scope)
    return items.length === 0
      ? undefined
      : [
          `## ${SCOPE_TITLES[scope] ?? scope}`,
          ...items.map(({ entry }) => bullet(entry.content)),
        ].join('\n')
  }).filter((group): group is string => group !== undefined)

  const note =
    dropped === 0
      ? undefined
      : `[Trimmed: ${dropped} older memor${dropped === 1 ? 'y entry was' : 'y entries were'} left out to fit the ${maxBytes}-byte memory limit.]`
  const text = [groups.join('\n\n'), note]
    .filter((part): part is string => part !== undefined)
    .join('\n\n')

  return { text, included: chosen.length, dropped, truncated: dropped > 0, bytes: utf8Length(text) }
}
