/**
 * 助手正文的 Markdown 渲染（M2-03，视觉规范 §6）：标题、列表、表格、引用、行内代码与代码块（GFM）。
 * 不渲染原始 HTML（react-markdown 默认转义），链接地址经默认的 urlTransform 过滤（去掉 javascript: 等），
 * 点击后由主进程交给系统浏览器打开（security.ts）。代码块用代码卡片（M2-06）：语言取自 info string，
 * 重点行写在其后的花括号里（` ```ts {2,4-6} `）。
 */
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeCard, parseLineRanges } from './CodeCard.js'
import { tokenize } from './composer-tokens.js'
import { languageByName } from './languages.js'

type Element = NonNullable<ExtraProps['node']>
type ElementContent = Element['children'][number]

const textOf = (nodes: readonly ElementContent[]): string =>
  nodes
    .map((n) => (n.type === 'text' ? n.value : n.type === 'element' ? textOf(n.children) : ''))
    .join('')

/**
 * 行内代码里的相对路径：`src/a.ts` 或 `src/a.ts:12`。只认带 `/` 的相对路径，
 * 排除绝对路径、`./` 与 `../` 开头、网址与带空白的文字。
 */
export function codePath(
  text: string,
): { readonly path: string; readonly line?: number } | undefined {
  const match =
    /^(?!\/)(?!\.{1,2}\/)(?!.*:\/\/)([^\s:`"'\\]+\/[^\s:`"'\\]+?)(?::(\d+)(?:-\d+)?)?$/.exec(text)
  if (match === null) return undefined
  const path = match[1] as string
  if (path.length > 4096) return undefined
  const line = match[2] === undefined ? undefined : Number(match[2])
  if (line !== undefined && line < 1) return undefined
  return line === undefined ? { path } : { path, line }
}

/** 一段 Markdown 里可能需要确认是否存在的行内代码路径（不含代码块），去重。 */
export function inlineCodeCandidates(text: string): string[] {
  const paths = new Set<string>()
  for (const token of tokenize(text)) {
    if (token.type !== 'code' || token.text.startsWith('```')) continue
    const parsed = codePath(token.text.slice(1, -1))
    if (parsed !== undefined) paths.add(parsed.path)
  }
  return [...paths]
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
   * 批量确认行内代码里的相对路径是否存在。存在时那段行内代码变成可点的路径；
   * 省略时保持原样（例如设置页预览）。
   */
  readonly resolvePaths?: ((paths: readonly string[]) => Promise<ReadonlySet<string>>) | undefined
  /** 点击可点的路径；`line` 是冒号后面的行号。 */
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
}

const EMPTY_PATHS: ReadonlySet<string> = new Set()

export function Markdown({ text, resolvePaths, onOpenFile }: MarkdownProps) {
  const [existing, setExisting] = useState<ReadonlySet<string>>(EMPTY_PATHS)
  const candidates = useMemo(() => inlineCodeCandidates(text), [text])

  useEffect(() => {
    // 没有点击处理时不必问主进程，路径保持普通行内代码。
    if (resolvePaths === undefined || onOpenFile === undefined || candidates.length === 0) {
      setExisting(EMPTY_PATHS)
      return
    }
    let alive = true
    void resolvePaths(candidates).then((paths) => {
      if (alive) setExisting(paths)
    })
    return () => {
      alive = false
    }
  }, [candidates, onOpenFile, resolvePaths])

  const activeComponents = useMemo<Components>(() => {
    if (resolvePaths === undefined || onOpenFile === undefined) return components
    return {
      ...components,
      code: (props) => {
        const raw = props.node ? textOf(props.node.children) : String(props.children ?? '')
        const parsed = codePath(raw)
        if (parsed !== undefined && existing.has(parsed.path)) {
          return (
            <button
              type="button"
              title={raw}
              onClick={() => onOpenFile(parsed.path, parsed.line)}
              className="cursor-pointer rounded-[5px] bg-sunk px-[5px] py-[1px] font-mono text-[0.87em] text-fg underline decoration-accent/40 underline-offset-2 outline-none hover:decoration-accent focus-visible:ring-1 focus-visible:ring-accent"
            >
              {raw}
            </button>
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
  }, [existing, onOpenFile, resolvePaths])

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={activeComponents}>
      {text}
    </ReactMarkdown>
  )
}
