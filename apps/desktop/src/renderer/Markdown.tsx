/**
 * 助手正文的 Markdown 渲染（M2-03，视觉规范 §6）：标题、列表、表格、引用、行内代码与代码块（GFM）。
 * 不渲染原始 HTML（react-markdown 默认转义），链接地址经默认的 urlTransform 过滤（去掉 javascript: 等），
 * 点击后由主进程交给系统浏览器打开（security.ts）。代码块先用简易样式，M2-06 换成代码卡片。
 */
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
  pre: (props) => (
    <pre
      className="my-3 overflow-x-auto rounded-card bg-code-bg px-4 py-3 font-mono text-code shadow-hair2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
      {...strip(props)}
    />
  ),
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

export function Markdown({ text }: { readonly text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
}
