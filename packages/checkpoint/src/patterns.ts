/** Git 输出的解析与 gitignore 规则（与 Git 进程无关，便于单独测试）。 */

/** 精确匹配一个路径（相对工作区，`/` 分隔）的 gitignore 规则；目录以 `/` 结尾。 */
export function exactPattern(rel: string): string {
  return '/' + rel.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ $/, '\\ ')
}

export interface StatusEntries {
  /** 工作区中有变化（新增或修改）的文件。 */
  readonly changed: string[]
  /** 嵌套仓库（含 `.git` 的子目录，不以 `/` 结尾）。 */
  readonly nested: string[]
}

/**
 * 解析 `git status --porcelain=v2 -z --untracked-files=all`。未跟踪的目录只在其中有 `.git`
 * （嵌套仓库）时以 `/` 结尾列出；已跟踪的 gitlink（`sub` 字段以 `S` 开头）同样是嵌套仓库。
 */
export function parseStatus(buf: Buffer): StatusEntries {
  const changed: string[] = []
  const nested: string[] = []
  for (const record of buf.toString('utf8').split('\0')) {
    if (record.startsWith('? ')) {
      const rel = record.slice(2)
      if (rel.endsWith('/')) nested.push(rel.slice(0, -1))
      else changed.push(rel)
    } else if (record.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = record.split(' ')
      const rel = parts.slice(8).join(' ')
      if (parts[2]!.startsWith('S')) nested.push(rel)
      else if (parts[1]![1] !== 'D') changed.push(rel)
    }
  }
  return { changed, nested }
}

export type ChangeStatus = 'added' | 'modified' | 'deleted'

export interface FileChange {
  readonly path: string
  readonly status: ChangeStatus
}

const STATUS: Readonly<Record<string, ChangeStatus>> = { A: 'added', D: 'deleted' }

/** 解析 `git diff-tree -r -z --no-renames --name-status`；类型变化（如文件 ↔ 符号链接）算作修改。 */
export function parseNameStatus(buf: Buffer): FileChange[] {
  const parts = buf.toString('utf8').split('\0').filter(Boolean)
  const out: FileChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ path: parts[i + 1]!, status: STATUS[parts[i]!] ?? 'modified' })
  }
  return out
}

/** 检查点 id：完整的 SHA-1 或 SHA-256 提交 id（拒绝选项、引用名等其他输入）。 */
export function isCheckpointId(id: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)
}

/** Git 配置文件中的字符串值。 */
export function configValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
