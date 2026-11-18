// @ts-check
/**
 * 发布脚本共用的文件工具（M6-07）。
 *
 * 汇总任务（`merge-release.mjs`）在标签的裸检出里直接由 node 运行，不安装工作区依赖；
 * 因此这些工具单独放在这里，不经过 `release-artifacts.mjs`（它依赖 `@cairn/release-tools`）。
 * 否则汇总任务会因缺少 workspace 链接以 `ERR_MODULE_NOT_FOUND` 失败。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const PLATFORM_NOTES_SCHEMA_VERSION = 1

/**
 * @param {string} file
 * @returns {string}
 */
export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 读取 JSON 对象；不是对象时抛出。
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function readJson(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return parsed
}

/**
 * 写入 `SHA256SUMS`（`<hex>  <file name>`），返回行数。
 * @param {{ directory: string; files: readonly string[] }} input
 * @returns {number}
 */
export function writeChecksums({ directory, files }) {
  const names = [...new Set(files.map((file) => path.basename(file)))].sort()
  const lines = names.map((name) => `${sha256(path.join(directory, name))}  ${name}`)
  writeFileSync(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return names.length
}
