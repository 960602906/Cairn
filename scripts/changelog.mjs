// @ts-check
/**
 * CHANGELOG 段落抽取：发布说明与构建信息（重启后的“更新内容”弹窗）共用同一份规则。
 *
 * 只按 Keep a Changelog 的二级版本标题匹配 `## [x.y.z] - 日期`，抽到下一个二级标题为止；
 * 找不到或正文为空时抛错，避免把空说明发布出去。
 */

/**
 * 从 CHANGELOG 中抽取指定版本的正文；找不到或正文为空时抛错。
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 标题行只允许行内空白：`\s` 会跨行吞掉空行与正文，导致 section 变空。
  const heading = new RegExp(`^## \\[${escaped}\\](?:[ \\t]+-[ \\t]+[^\\n]*)?[ \\t]*$`, 'm')
  const match = heading.exec(changelog)
  if (match === null) throw new Error(`CHANGELOG.md has no section for ${version}`)
  const start = match.index + match[0].length
  const rest = changelog.slice(start)
  const next = /^## \[/m.exec(rest)
  const section = (next === null ? rest : rest.slice(0, next.index)).trim()
  if (section === '') throw new Error(`CHANGELOG.md section for ${version} is empty`)
  return section
}
