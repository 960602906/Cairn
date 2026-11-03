// 工作区文件清单：路径 → 内容哈希（含可执行位与符号链接目标），用于独立校验恢复结果。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IS_WINDOWS } from './fixture.mjs'

export function walk(root, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(root, child, out)
    else out.push(child)
  }
  return out
}

function entryOf(root, rel) {
  const file = path.join(root, ...rel.split('/'))
  const st = fs.lstatSync(file)
  if (st.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  const exec = !IS_WINDOWS && (st.mode & 0o111) !== 0 ? 'x' : '-'
  return `${exec}${hash}`
}

/** filter(rel) 为 true 的文件组成的清单。 */
export function manifest(root, filter) {
  const map = new Map()
  for (const rel of walk(root)) if (filter(rel)) map.set(rel, entryOf(root, rel))
  return map
}

export function sizeOf(root) {
  return (rel) => {
    try {
      return fs.lstatSync(path.join(root, ...rel.split('/'))).size
    } catch {
      return 0
    }
  }
}

/** 两份清单的差异（最多列出 limit 条），相同时返回空数组。 */
export function diffManifest(expected, actual, limit = 10) {
  const out = []
  for (const [rel, v] of expected) {
    if (!actual.has(rel)) out.push(`missing ${rel}`)
    else if (actual.get(rel) !== v) out.push(`changed ${rel}`)
  }
  for (const rel of actual.keys()) if (!expected.has(rel)) out.push(`extra ${rel}`)
  return out.slice(0, limit).concat(out.length > limit ? [`… ${out.length - limit} more`] : [])
}

/** 目录下的空目录（相对路径）。 */
export function emptyDirs(root, rel = '', out = []) {
  const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  if (rel && entries.length === 0) out.push(rel)
  for (const e of entries)
    if (e.isDirectory()) emptyDirs(root, rel ? `${rel}/${e.name}` : e.name, out)
  return out
}

export function dirStats(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        files++
        bytes += fs.statSync(p).size
      }
    }
  }
  return { files, bytes }
}
