/**
 * 文件标签的只读预览：主进程 `fs.read` 读取内容，Shiki 高亮（`highlight.ts`），
 * 行号、换行、复制、刷新与在资源管理器中显示。超大文件只渲染前 5,000 行。
 */
import { FolderOpen, RefreshCw, TriangleAlert, WrapText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import { translateError } from '@cairn/i18n'
import { RpcError, type FileContent, type ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { CopyButton } from './CopyButton.js'
import { splitPath, Token } from './CodeCard.js'
import { FileTypeIcon } from './file-icons.js'
import { useHighlight } from './highlight.js'
import { languageForPath } from './languages.js'
import { useSessionStore } from './store-context.js'
import { Button, cn, PanelEmpty, Spinner } from './ui/index.js'
import { formatBytes } from './update-model.js'

export const FILE_PREVIEW_MAX_LINES = 5000

const EMPTY_PROJECTS: readonly ProjectSummary[] = []

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly content: FileContent }
  | { readonly status: 'error'; readonly message: string }

function IconAction({
  label,
  onClick,
  pressed,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean | undefined
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent [&_svg]:size-3.5',
        pressed && 'text-accent',
      )}
    >
      {children}
    </button>
  )
}

export function FileViewer({
  path,
  view,
  line,
}: {
  /** 相对项目根的路径。 */
  readonly path: string
  readonly view: SessionView | undefined
  /** 打开后定位并高亮的行号（从 1 开始）；来自消息里的 `path:12`。 */
  readonly line?: number | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const projects = useSessionStore((state) => state.projects ?? EMPTY_PROJECTS)
  const projectPath = view?.info?.projectPath
  const project = projects.find((item) => item.path === projectPath)
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [wrap, setWrap] = useState(false)

  useEffect(() => {
    if (!project) {
      setState({ status: 'error', message: t('fileTree.noProject') })
      return
    }
    const api = getMainApi()
    if (!api) {
      setState({ status: 'error', message: t('fileViewer.error') })
      return
    }
    let alive = true
    setState({ status: 'loading' })
    void api
      .request('fs.read', { projectId: project.projectId, path })
      .then((result) => {
        if (alive) setState({ status: 'ready', content: result.content })
      })
      .catch((cause: unknown) => {
        if (alive) {
          const info = cause instanceof RpcError ? cause.toInfo() : { code: 'rpc.internal' }
          setState({
            status: 'error',
            message: translateError(i18n, info),
          })
        }
      })
    return () => {
      alive = false
    }
  }, [i18n, path, project?.projectId, t, version])

  const content = state.status === 'ready' ? state.content : undefined
  const text = content?.kind === 'text' ? content.text : ''
  const displayText = useMemo(() => text.replace(/\r\n?/g, '\n').replace(/\n$/, ''), [text])
  const allLines = useMemo(() => (displayText === '' ? [] : displayText.split('\n')), [displayText])
  const truncated = allLines.length > FILE_PREVIEW_MAX_LINES
  const lines = truncated ? allLines.slice(0, FILE_PREVIEW_MAX_LINES) : allLines
  const previewText = useMemo(() => lines.join('\n'), [lines])
  const language = languageForPath(path)
  const tokens = useHighlight(previewText, language)
  const { dir, name } = splitPath(path)
  const gutter = String(lines.length).length > 4 ? 'w-[58px]' : 'w-[46px]'
  const scroller = useRef<HTMLDivElement>(null)

  // 从消息里的 `path:12` 打开：等内容渲染出来后滚到那一行。
  useEffect(() => {
    if (line === undefined || state.status !== 'ready') return
    const target = scroller.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [line, path, state.status])

  const reveal = () => {
    if (!project) return
    void getMainApi()?.request('fs.reveal', { projectId: project.projectId, path })
  }

  return (
    <section aria-label={t('fileViewer.label', { path })} className="flex h-full min-h-0 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b-[0.5px] border-hair bg-code-head pr-1.5 pl-3 text-note">
        <FileTypeIcon name={name} />
        <span className="min-w-0 truncate font-mono text-[12px]" title={path}>
          {dir && <span className="text-muted">{dir}</span>}
          <span className="font-semibold text-fg">{name}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconAction
            label={t('code.wrap')}
            pressed={wrap}
            onClick={() => setWrap((current) => !current)}
          >
            <WrapText aria-hidden />
          </IconAction>
          <IconAction label={t('fileViewer.refresh')} onClick={() => setVersion((n) => n + 1)}>
            <RefreshCw aria-hidden />
          </IconAction>
          <IconAction label={t('fileTree.reveal')} onClick={reveal}>
            <FolderOpen aria-hidden />
          </IconAction>
          {content?.kind === 'text' && (
            <CopyButton text={text} className="hover:bg-hover hover:text-fg" />
          )}
        </span>
      </div>

      {state.status === 'loading' ? (
        <p role="status" className="flex items-center gap-2 px-4 py-3 text-note text-muted">
          <Spinner className="size-3.5" />
          {t('fileViewer.loading')}
        </p>
      ) : state.status === 'error' ? (
        <div>
          <PanelEmpty icon={<TriangleAlert />} hint={state.message} className="px-4">
            {t('fileViewer.error')}
          </PanelEmpty>
          <div className="flex justify-center pb-4">
            <Button size="sm" variant="ghost" onClick={() => setVersion((n) => n + 1)}>
              {t('fileViewer.retry')}
            </Button>
          </div>
        </div>
      ) : content?.kind === 'binary' ? (
        <PanelEmpty icon={<TriangleAlert />} hint={formatBytes(content.size)} className="px-4">
          {t('fileViewer.binary')}
        </PanelEmpty>
      ) : content?.kind === 'too_large' ? (
        <PanelEmpty icon={<TriangleAlert />} hint={formatBytes(content.size)} className="px-4">
          {t('fileViewer.tooLarge')}
        </PanelEmpty>
      ) : content?.kind === 'text' && displayText === '' ? (
        <PanelEmpty className="px-4">{t('fileViewer.empty')}</PanelEmpty>
      ) : (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-auto py-2.5 font-mono text-code [tab-size:4]"
        >
          <div className={cn(wrap ? 'w-full' : 'w-max min-w-full')}>
            {lines.map((row, index) => (
              <div
                key={index}
                data-line={index + 1}
                className={cn('flex', line === index + 1 && 'bg-accent-soft')}
              >
                <span
                  aria-hidden
                  className={cn('tabular shrink-0 pr-4 text-right text-gutter select-none', gutter)}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 pr-4 text-tk-v',
                    wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
                  )}
                >
                  {tokens?.[index]
                    ? tokens[index]!.map((token, tokenIndex) => (
                        <Token key={tokenIndex} token={token} />
                      ))
                    : row}
                </span>
              </div>
            ))}
            {truncated && (
              <p className="px-4 pt-2 pb-1 text-note text-faint">
                {t('fileViewer.truncated', {
                  lines: FILE_PREVIEW_MAX_LINES,
                  total: allLines.length,
                })}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
