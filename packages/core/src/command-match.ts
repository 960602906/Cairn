/**
 * 命令匹配（M1-10a，权限规则的 `match.command`）。
 *
 * 命令按 shell 的连接符（`;`、`&&`、`||`、`|`、`&`、换行）拆成若干段，引号内的不拆。`allow` 规则要求每一段都匹配，
 * 避免 `npm test*` 放行 `npm test && rm -rf ~`；含命令替换（`$(…)`、反引号、`<(…)`）或引号不配对的命令无法可靠
 * 拆分，`allow` 规则不匹配（仍按默认询问）。`deny` / `ask` 规则只要任一段或整条命令匹配即可。
 *
 * 这只是防误操作的安全网，不是安全边界（ADR-0007）：脚本、别名等间接执行无法识别。
 */

export interface ParsedCommand {
  /** 规范化后的整条命令（去掉首尾空白，连续空白合并为一个空格）。 */
  readonly normalized: string
  /** 规范化后的各段（不含空段）。 */
  readonly segments: readonly string[]
  /** 能否可靠拆分；不能时 `allow` 规则不匹配。 */
  readonly reliable: boolean
}

export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, ' ')

/** 拆分命令：引号内（`'…'`、`"…"`）的连接符不拆。 */
export function parseCommand(command: string): ParsedCommand {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let reliable = true
  const flush = () => {
    const segment = normalizeCommand(current)
    if (segment !== '') segments.push(segment)
    current = ''
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      // 双引号内的 $( 与反引号同样会执行
      if (quote === '"' && (char === '`' || (char === '$' && command[i + 1] === '('))) {
        reliable = false
      }
      if (char === quote) quote = undefined
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (
      char === '`' ||
      ((char === '$' || char === '<' || char === '>') && command[i + 1] === '(')
    ) {
      reliable = false
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      flush()
      continue
    }
    current += char
  }
  if (quote) reliable = false
  flush()
  return { normalized: normalizeCommand(command), segments, reliable }
}

const escape = (text: string) => text.replace(/[.*+^${}()|[\]\\?]/g, '\\$&')

/**
 * 命令模式：`*` 匹配任意字符，`\\*` 匹配字面的 `*`，其余（包括其他 `\\`，如 Windows 路径）按字面；
 * 空白规范化后整体匹配。
 */
export function commandPatternToRegExp(pattern: string, caseInsensitive = false): RegExp {
  const source = normalizeCommand(pattern)
    .split(/(\\\*|\*)/)
    .map((part) => (part === '*' ? '.*' : part === '\\*' ? '\\*' : escape(part)))
    .join('')
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '')
}

/**
 * 命令是否匹配模式之一。`mode: 'every'`（用于 allow）要求可靠拆分且每段都匹配；`'any'`（用于 deny / ask）
 * 任一段或整条命令匹配即可。
 */
export function matchCommand(
  parsed: ParsedCommand,
  patterns: readonly string[],
  mode: 'every' | 'any',
  caseInsensitive = false,
): boolean {
  const regexes = patterns.map((p) => commandPatternToRegExp(p, caseInsensitive))
  const matches = (text: string) => regexes.some((r) => r.test(text))
  if (mode === 'every') {
    return parsed.reliable && parsed.segments.length > 0 && parsed.segments.every(matches)
  }
  return matches(parsed.normalized) || parsed.segments.some(matches)
}
