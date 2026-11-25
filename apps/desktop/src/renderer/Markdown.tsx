/**
 * 助手正文的 Markdown 渲染（M2-03，视觉规范 §6）：标题、列表、表格、引用、行内代码与代码块（GFM）。
 * 不渲染原始 HTML（react-markdown 默认转义），链接地址经默认的 urlTransform 过滤（去掉 javascript: 等），
 * 点击后由主进程交给系统浏览器打开（security.ts）。
 *
 * 正文与行内代码里像文件名的引用（`file-refs.ts`）先批量问主进程是否存在，确认后点击在右侧打开；
 * 正文里的引用由 remark 插件换成 `#cairn-file=` 链接，再由 `a` / `code` 组件认出来。
 *
 * 代码块用代码卡片（M2-06）：语言取自 info string，
 * 重点行写在其后的花括号里（` ```ts {2,4-6} `）。
 *
 * 进行中的回复（`streaming`）按 `splitStableBlocks` 切块：已经写完的块缓存渲染结果，每次增量只重新解析
 * 最后一块；最后一块里的代码块高亮节流。回复完成后由已完成的消息按整段重新渲染。
 */
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeCard, parseLineRanges } from './CodeCard.js'
import { FileTypeIcon } from './file-icons.js'
import { fileRefCandidates, fileRefsInText, parseFileRef } from './file-refs.js'
import { languageByName } from './languages.js'
import { splitStableBlocks } from './markdown-blocks.js'

type Element = NonNullable<ExtraProps['node']>
type ElementContent = Element['children'][number]

const textOf = (nodes: readonly ElementContent[]): string =>
  nodes
    .map((n) => (n.type === 'text' ? n.value : n.type === 'element' ? textOf(n.children) : ''))
    .join('')

/** 正文里文件引用链接的地址前缀；`a` 组件据此把自己换成打开文件的按钮。 */
const FILE_REF_HREF = '#cairn-file='

/** mdast 的最小结构：只用到文本、链接和子节点。 */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/** 把一段文字按文件引用切开：普通文字保持原样，引用换成 `#cairn-file=` 链接。 */
function splitTextNode(value: string): MdNode[] {
  const refs = fileRefsInText(value)
  if (refs.length === 0) return [{ type: 'text', value }]
  const nodes: MdNode[] = []
  let cursor = 0
  for (const { start, end } of refs) {
    if (start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, start) })
    nodes.push({
      type: 'link',
      url: `${FILE_REF_HREF}${encodeURIComponent(value.slice(start, end))}`,
      children: [{ type: 'text', value: value.slice(start, end) }],
    })
    cursor = end
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}

/** 递归处理整棵树；链接、代码、图片里面不再找。 */
function linkifyFileRefs(node: MdNode): void {
  const children = node.children
  if (children === undefined) return
  const next: MdNode[] = []
  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...splitTextNode(child.value))
      continue
    }
    if (
      child.type !== 'link' &&
      child.type !== 'inlineCode' &&
      child.type !== 'code' &&
      child.type !== 'html' &&
      child.type !== 'image'
    ) {
      linkifyFileRefs(child)
    }
    next.push(child)
  }
  node.children = next
}

/** remark 插件：正文里的文件名换成可识别的链接。 */
export function remarkFileRefs() {
  return (tree: unknown) => {
    linkifyFileRefs(tree as MdNode)
  }
}

/** 从链接地址里取出引用原文；不是文件引用链接时返回 undefined。 */
export function fileRefFromHref(href: string | undefined): string | undefined {
  if (href === undefined || !href.startsWith(FILE_REF_HREF)) return undefined
  try {
    return decodeURIComponent(href.slice(FILE_REF_HREF.length))
  } catch {
    return undefined
  }
}

/** 代码块的语言、重点行与正文；结构不是 `<pre><code>` 时返回 undefined。 */
export function codeBlockOf(pre: Element | undefined) {
  const code = pre?.children.find((c): c is Element => c.type === 'element')
  if (!code || code.tagName !== 'code') return undefined
  const classes = code.properties['className']
  const lang = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((c) => c.startsWith('language-'))
    ?.slice('language-'.length)
  const meta = (code.data as { meta?: unknown } | undefined)?.meta
  return {
    lang,
    highlightLines: parseLineRanges(typeof meta === 'string' ? meta : undefined),
    text: textOf(code.children).replace(/\n$/, ''),
  }
}

/** 所在的块还在流式输出：代码块交给 `CodeCard` 的 `streaming`。 */
const StreamingContext = createContext(false)

const components: Components = {
  h1: (props) => <h3 className="mt-5 mb-2 text-heading text-fg first:mt-0" {...strip(props)} />,
  h2: (props) => <h3 className="mt-5 mb-2 text-heading text-fg first:mt-0" {...strip(props)} />,
  h3: (props) => (
    <h4 className="mt-4 mb-1.5 text-[15px] font-semibold text-fg first:mt-0" {...strip(props)} />
  ),
  h4: (props) => (
    <h4 className="mt-4 mb-1.5 text-[15px] font-semibold text-fg first:mt-0" {...strip(props)} />
  ),
  h5: (props) => <h5 className="mt-3 mb-1 font-semibold text-fg first:mt-0" {...strip(props)} />,
  h6: (props) => <h6 className="mt-3 mb-1 font-semibold text-fg2 first:mt-0" {...strip(props)} />,
  p: (props) => <p className="my-2.5 first:mt-0 last:mb-0" {...strip(props)} />,
  ul: (props) => <ul className="my-2.5 list-disc pl-6 marker:text-faint" {...strip(props)} />,
  ol: (props) => <ol className="my-2.5 list-decimal pl-6 marker:text-muted" {...strip(props)} />,
  li: (props) => <li className="my-1 pl-1" {...strip(props)} />,
  blockquote: (props) => (
    <blockquote className="my-3 border-l-2 border-hair2 pl-3.5 text-fg2" {...strip(props)} />
  ),
  hr: () => <hr className="my-5 border-0 border-t-[0.5px] border-hair2" />,
  a: ({ node: _node, ...props }) => (
    <a
      className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  table: (props) => (
    <div className="my-3 overflow-x-auto rounded-card shadow-hair2">
      <table className="w-full border-collapse text-[14px]" {...strip(props)} />
    </div>
  ),
  th: (props) => (
    <th
      className="border-b-[0.5px] border-hair2 bg-sunk px-3 py-2 text-left font-semibold text-fg"
      {...strip(props)}
    />
  ),
  td: (props) => (
    <td className="border-b-[0.5px] border-hair px-3 py-2 align-top" {...strip(props)} />
  ),
  pre: (props) => {
    const streaming = useContext(StreamingContext)
    const block = codeBlockOf(props.node)
    if (!block) {
      return (
        <pre
          className="my-3 overflow-x-auto rounded-card bg-code-bg px-4 py-3 font-mono text-code shadow-hair2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
          {...strip(props)}
        />
      )
    }
    return (
      <CodeCard
        code={block.text}
        language={languageByName(block.lang)}
        languageName={block.lang}
        highlightLines={block.highlightLines}
        streaming={streaming}
      />
    )
  },
  code: (props) => (
    <code
      className="rounded-[5px] bg-sunk px-[5px] py-[1px] font-mono text-[0.87em] text-fg"
      {...strip(props)}
    />
  ),
}

/** 去掉 react-markdown 传入的 `node`，不让它落到 DOM 属性上。 */
function strip<T extends { node?: unknown }>({ node: _node, ...rest }: T): Omit<T, 'node'> {
  return rest
}

export interface MarkdownProps {
  readonly text: string
  /**
   * 批量把正文与行内代码里的文件引用解析成项目内的相对路径（引用 → 真实路径）。
   * 解析成功的引用变成可点的路径；省略时保持原样（例如设置页预览）。
   */
  readonly resolvePaths?:
    ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined
  /** 点击可点的路径；`path` 是项目内的真实路径，`line` 是冒号后面的行号。 */
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
  /** 流式输出时可选的防抖毫秒数，避免每个 token 产生重复 IPC 请求。 */
  readonly debounceMs?: number
  /**
   * 进行中的回复（性能）：文本每次增量都会变长，按块渲染，已经写完的块不再重新解析；
   * 最后一块里的代码块高亮节流。
   */
  readonly streaming?: boolean
}

const EMPTY_RESOLVED: ReadonlyMap<string, string> = new Map()
const REMARK_PLUGINS = [remarkGfm]
const REMARK_PLUGINS_WITH_FILES = [remarkGfm, remarkFileRefs]

/** 正文与行内代码里确认过存在的文件引用，点击在右侧打开。 */
function FileRefLink({
  raw,
  target,
  line,
  onOpenFile,
}: {
  readonly raw: string
  readonly target: string
  readonly line: number | undefined
  readonly onOpenFile: (path: string, line?: number) => void
}) {
  return (
    <button
      type="button"
      title={raw}
      onClick={() => onOpenFile(target, line)}
      className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-[2px] text-accent underline decoration-accent/30 underline-offset-2 outline-none hover:decoration-accent focus-visible:ring-1 focus-visible:ring-accent"
    >
      <FileTypeIcon name={target} className="size-3" />
      <span className="truncate">{raw}</span>
    </button>
  )
}

const MarkdownBody = memo(function MarkdownBody({
  text,
  resolvePaths,
  onOpenFile,
  debounceMs = 0,
  streaming = false,
}: MarkdownProps) {
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(EMPTY_RESOLVED)
  const candidates = useMemo(() => fileRefCandidates(text), [text])
  const candidatesKey = useMemo(() => candidates.join('\0'), [candidates])

  useEffect(() => {
    // 没有点击处理时不必问主进程，引用保持普通文字。
    if (resolvePaths === undefined || onOpenFile === undefined || candidates.length === 0) {
      setResolved(EMPTY_RESOLVED)
      return
    }
    let alive = true
    const check = () => {
      void resolvePaths(candidates).then((paths) => {
        if (alive) setResolved(paths)
      })
    }
    if (debounceMs > 0) {
      const timer = setTimeout(check, debounceMs)
      return () => {
        alive = false
        clearTimeout(timer)
      }
    }
    check()
    return () => {
      alive = false
    }
  }, [candidatesKey, onOpenFile, resolvePaths, debounceMs])

  const activeComponents = useMemo<Components>(() => {
    if (resolvePaths === undefined || onOpenFile === undefined) return components
    return {
      ...components,
      a: ({ node: _node, href, children, ...props }) => {
        const raw = fileRefFromHref(href)
        if (raw !== undefined) {
          const parsed = parseFileRef(raw)
          const target = parsed === undefined ? undefined : resolved.get(parsed.path)
          if (parsed !== undefined && target !== undefined) {
            return (
              <FileRefLink raw={raw} target={target} line={parsed.line} onOpenFile={onOpenFile} />
            )
          }
          // 解析不到的文件名保持普通文字，不显示成链接。
          return <span>{children}</span>
        }
        return (
          <a
            className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
            target="_blank"
            rel="noreferrer"
            href={href}
            {...props}
          >
            {children}
          </a>
        )
      },
      code: (props) => {
        const raw = props.node ? textOf(props.node.children) : String(props.children ?? '')
        const parsed = parseFileRef(raw)
        const target = parsed === undefined ? undefined : resolved.get(parsed.path)
        if (parsed !== undefined && target !== undefined) {
          return (
            <code className="rounded-[5px] bg-sunk px-[5px] py-[1px] font-mono text-[0.87em]">
              <FileRefLink raw={raw} target={target} line={parsed.line} onOpenFile={onOpenFile} />
            </code>
          )
        }
        return (
          <code
            className="rounded-[5px] bg-sunk px-[5px] py-[1px] font-mono text-[0.87em] text-fg"
            {...strip(props)}
          />
        )
      },
    }
  }, [resolved, onOpenFile, resolvePaths])

  return (
    <StreamingContext.Provider value={streaming}>
      <ReactMarkdown
        remarkPlugins={
          resolvePaths === undefined || onOpenFile === undefined
            ? REMARK_PLUGINS
            : REMARK_PLUGINS_WITH_FILES
        }
        components={activeComponents}
      >
        {text}
      </ReactMarkdown>
    </StreamingContext.Provider>
  )
})

export function Markdown(props: MarkdownProps) {
  const { text, streaming = false } = props
  const blocks = useMemo(() => (streaming ? splitStableBlocks(text) : undefined), [streaming, text])
  if (blocks === undefined) return <MarkdownBody {...props} />
  // 前面的块写完后文本不再变化，`MarkdownBody` 的 memo 让它们跳过重渲染；只有最后一块还在流式输出。
  const last = blocks.length - 1
  return blocks.map((block, index) => (
    <MarkdownBody key={index} {...props} text={block} streaming={index === last} />
  ))
}
