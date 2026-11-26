/**
 * 会话内查找（⌘F）：在渲染后的对话里找文本，生成用于高亮的 Range。
 *
 * 跨文本节点匹配：Markdown 会把一句话拆进多个 `<span>`（加粗、行内代码、高亮 token），
 * 只按单个文本节点搜索会漏掉这类匹配。这里把可搜索的文本节点拼成一个串，记下每段的偏移，
 * 再把命中的区间映射回 Range。隐藏的辅助文字（`data-find-ignore`）不参与搜索。
 */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'])

interface Segment {
  readonly node: Text
  readonly start: number
  readonly end: number
}

const isSkipped = (node: Text): boolean => {
  const parent = node.parentElement
  if (parent === null || SKIP_TAGS.has(parent.tagName)) return true
  return parent.closest('[data-find-ignore]') !== null
}

/** 搜索根节点下所有可匹配文本节点，按文档顺序拼成 `{text, segments}`。 */
function collect(root: Node): { text: string; segments: Segment[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segments: Segment[] = []
  let text = ''
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.textContent ?? ''
    if (value === '' || isSkipped(node as Text)) continue
    const start = text.length
    text += value
    segments.push({ node: node as Text, start, end: text.length })
  }
  return { text, segments }
}

/** 命中的字符偏移转成 Range；起点落在节点边界时取后一段，终点落在边界时取前一段。 */
function rangeFor(segments: readonly Segment[], start: number, end: number): Range | undefined {
  const from = segments.find((segment) => start < segment.end)
  const to = segments.find((segment) => end <= segment.end)
  if (from === undefined || to === undefined) return undefined
  const range = document.createRange()
  range.setStart(from.node, start - from.start)
  range.setEnd(to.node, end - to.start)
  return range
}

/**
 * 在 `root` 内查找 `query`（不区分大小写），返回按文档顺序排列的 Range。
 * 空查询（或只有空白）返回空数组；相邻或重叠的命中不合并，与浏览器的逐处跳转一致。
 */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.trim()
  if (needle === '') return []
  const { text, segments } = collect(root)
  if (segments.length === 0) return []
  // 个别字符转小写会改变长度（如 İ）；此时退回区分大小写，保证偏移仍然正确。
  const lower = text.toLowerCase()
  const haystack = lower.length === text.length ? lower : text
  const target = lower.length === text.length ? needle.toLowerCase() : needle
  const ranges: Range[] = []
  let index = haystack.indexOf(target)
  while (index !== -1) {
    const range = rangeFor(segments, index, index + target.length)
    if (range !== undefined) ranges.push(range)
    index = haystack.indexOf(target, index + target.length)
  }
  return ranges
}

/** 命中位置所在的元素：用于把当前结果滚到视野中央。 */
export function matchElement(range: Range): Element | undefined {
  const node = range.startContainer
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node.parentElement ?? undefined)
}
