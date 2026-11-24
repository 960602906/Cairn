/**
 * 流式输出的 Markdown 分块（性能）：进行中的回复每次增量都会变长，整段交给 react-markdown 时解析量随长度
 * 增长。这里把文本切成若干块，除最后一块外，每一块在后面追加文字之后都保持不变，界面可以按块缓存渲染
 * 结果，每次只重新解析最后一块。
 *
 * 只在代码围栏之外的空行处切开，并且要求空行的下一行已经写完（不是最后一行）、顶格、不是列表项：缩进的
 * 续行、缩进代码块与松散列表都留在同一块里。用 `\n\n` 把各块接起来就是原文。
 *
 * 与整段渲染的差别只在跨块的链接引用定义与脚注：流式期间暂时不生效，回复完成后按整段重新渲染时恢复。
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/

export function splitStableBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let start = 0
  let fence: { readonly char: string; readonly length: number } | undefined
  /** 当前块里出现过非空行（不切出空块）。 */
  let content = false
  // 最后一行可能还没写完，不参与判断
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      // 关闭围栏：同一种字符、不短于开始的围栏，后面只有空白
      if (
        marker !== undefined &&
        marker.charAt(0) === fence.char &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined
      }
      continue
    }
    if (marker !== undefined) {
      fence = { char: marker.charAt(0), length: marker.length }
      content = true
      continue
    }
    if (line.trim() !== '') {
      content = true
      continue
    }
    // 空行：下一行要已经写完，才能判断它是不是新的一块
    if (!content || i + 1 === lines.length - 1) continue
    const next = lines[i + 1]!
    if (next.trim() === '' || /^\s/.test(next) || LIST_ITEM.test(next)) continue
    blocks.push(lines.slice(start, i).join('\n'))
    start = i + 1
    content = false
  }
  blocks.push(lines.slice(start).join('\n'))
  return blocks
}
