/**
 * 路径 glob（M1-10a，权限规则的 `match.path`）：匹配相对工作区、以 `/` 分隔的路径。
 *
 * - `*` 匹配一段路径中的任意字符（不含 `/`），`?` 匹配一个字符（不含 `/`）；
 * - `**` 作为完整的一段时匹配零或多段目录（`src/**`、`**\/.env*`、`a/**\/b`）；
 * - `{a,b}` 匹配其中之一（不嵌套）；`[abc]` 匹配其中一个字符（字面，不支持范围与取反，`[*]` 即字面的 `*`）；
 * - 其他字符按字面匹配；模式中的 `\` 视为 `/`（Windows 写法）。
 *
 * 不依赖 `node:path`，core 在任何环境都可运行。
 */

const escape = (char: string) => char.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')

function segmentSource(pattern: string): string {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '[') {
      // 紧跟 `[` 的 `]` 属于字符本身（`[]]`）
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) {
        source += escape(char)
        continue
      }
      source += `[${pattern.slice(i + 1, end).replace(/[\]\\^-]/g, '\\$&')}]`
      i = end
    } else if (char === '{') {
      const end = pattern.indexOf('}', i)
      if (end < 0) {
        source += escape(char)
        continue
      }
      const options = pattern
        .slice(i + 1, end)
        .split(',')
        .map(segmentSource)
      source += `(?:${options.join('|')})`
      i = end
    } else source += escape(char)
  }
  return source
}

/** 把 glob 编译为正则表达式（整体匹配）。 */
export function globToRegExp(pattern: string, options: { caseInsensitive?: boolean } = {}): RegExp {
  const segments = pattern.replace(/\\/g, '/').replace(/^\.\//, '').split('/')
  let source = ''
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      // 末尾的 `**` 匹配其下的一切；中间的 `**/` 匹配零或多段目录
      source += last ? '.*' : '(?:[^/]+/)*'
      return
    }
    source += segmentSource(segment) + (last ? '' : '/')
  })
  return new RegExp(`^${source}$`, options.caseInsensitive ? 'i' : '')
}

/** `path` 是否匹配 `pattern`。 */
export function matchGlob(
  pattern: string,
  path: string,
  options: { caseInsensitive?: boolean } = {},
): boolean {
  return globToRegExp(pattern, options).test(path.replace(/\\/g, '/'))
}
