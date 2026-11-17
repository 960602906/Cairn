/**
 * 文件标签：源码预览与这笔文件改动的 diff 两种视图。
 *
 * - **预览**：主进程 `fs.read` 读取内容，Shiki 高亮（`highlight.ts`），行号、换行、复制、刷新与在资源管理器
 *   中显示。超大文件只渲染前 5,000 行。
 * - **改动**：文件有改动时（本会话的改动，或子运行待审阅改动集里的文件）默认显示 diff；可以切回预览。
 *   会话改动复用 `FileDiff`（带撤销）；改动集文件复用 `DiffCard`，并给出进入改动集审阅的入口。
 */
import { FolderOpen, RefreshCw, TriangleAlert, WrapText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import { translateError } from '@cairn/i18n'
import { RpcError, type FileContent, type ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { FileStatusBadge } from './ChangeSetReview.js'
import { changeSetDiffContent, changeSetFileKind } from './change-set-patch.js'
import { CopyButton } from './CopyButton.js'
import { splitPath, Token } from './CodeCard.js'
import { DiffCard } from './DiffCard.js'
import type { FileDiffMode } from './file-changes.js'
import { useFileChangeSource } from './file-change-source.js'
import { FileDiff, useCanRevert } from './FileChanges.js'
import { FileTypeIcon } from './file-icons.js'
import { useHighlight } from './highlight.js'
import { languageForPath } from './languages.js'
import { useSessionStore } from './store-context.js'
import { Button, cn, PanelEmpty, SegmentedControl, Spinner } from './ui/index.js'
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

/**
 * 读取文件内容。`enabled` 为假时（改动视图）不请求：隔离工作区里新增的文件在主工作区还不存在，
 * 此时 `fs.read` 只会白白报错。已经读到的内容按 `项目:路径:版本` 记住，切回预览不重复请求。
 */
function usePreviewContent({
  projectId,
  path,
  enabled,
  version,
}: {
  readonly projectId: string | undefined
  readonly path: string
  readonly enabled: boolean
  readonly version: number
}): LoadState {
  const { t, i18n } = useTranslation('session')
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const loaded = useRef<string>(undefined)
  useEffect(() => {
    if (!enabled) return
    if (projectId === undefined) {
      setState({ status: 'error', message: t('fileTree.noProject') })
      return
    }
    const api = getMainApi()
    if (!api) {
      setState({ status: 'error', message: t('fileViewer.error') })
      return
    }
    const key = `${projectId}:${path}:${version}`
    if (loaded.current === key) return
    let alive = true
    setState({ status: 'loading' })
    void api
      .request('fs.read', { projectId, path })
      .then((result) => {
        if (!alive) return
        loaded.current = key
        setState({ status: 'ready', content: result.content })
      })
      .catch((cause: unknown) => {
        if (!alive) return
        const info = cause instanceof RpcError ? cause.toInfo() : { code: 'rpc.internal' }
        setState({ status: 'error', message: translateError(i18n, info) })
      })
    return () => {
      alive = false
    }
  }, [enabled, i18n, path, projectId, t, version])
  return state
}

export function FileViewer({
  path,
  view,
  sessionId,
  line,
  mode,
  onModeChange,
  onOpenChangeSet,
}: {
  /** 相对项目根的路径。 */
  readonly path: string
  readonly view: SessionView | undefined
  /** 改动来源所属的会话；省略时不做改动判断，只显示预览。 */
  readonly sessionId?: string | undefined
  /** 打开后定位并高亮的行号（从 1 开始）；来自消息里的 `path:12`，只在预览里生效。 */
  readonly line?: number | undefined
  /** 用户显式选择的视图；省略时按有没有改动自动决定。 */
  readonly mode?: FileDiffMode | undefined
  readonly onModeChange?: ((path: string, mode: FileDiffMode) => void) | undefined
  /** 改动集文件：打开对应的改动集审阅。 */
  readonly onOpenChangeSet?: ((changeSetId: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const projects = useSessionStore((state) => state.projects ?? EMPTY_PROJECTS)
  const projectPath = view?.info?.projectPath
  const project = projects.find((item) => item.path === projectPath)
  const [version, setVersion] = useState(0)
  const [wrap, setWrap] = useState(false)
  const source = useFileChangeSource(sessionId, path)
  const hasChanges = source.status === 'session' || source.status === 'changeSet'
  /** 还在等改动集详情：先不读源码，避免先闪一下预览再切到改动。 */
  const waiting = source.status === 'loading'
  const effective: FileDiffMode = hasChanges ? (mode ?? 'changes') : 'preview'
  const showPreview = effective === 'preview' && !waiting
  const state = usePreviewContent({
    projectId: project?.projectId,
    path,
    enabled: showPreview,
    version,
  })
  const canRevert = useCanRevert(sessionId ?? view?.sessionId ?? '')

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

  // 从消息里的 `path:12` 打开：等内容渲染出来后滚到那一行；切回预览时重新定位。
  useEffect(() => {
    if (!showPreview || line === undefined || state.status !== 'ready') return
    const target = scroller.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [line, path, showPreview, state.status])

  const reveal = () => {
    if (!project) return
    void getMainApi()?.request('fs.reveal', { projectId: project.projectId, path })
  }
  const changeSet = source.status === 'changeSet' ? source.changeSet : undefined

  return (
    <section
      aria-label={
        effective === 'changes'
          ? t('fileViewer.changesLabel', { path })
          : t('fileViewer.label', { path })
      }
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b-[0.5px] border-hair bg-code-head pr-1.5 pl-3 text-note">
        <FileTypeIcon name={name} />
        <span className="min-w-0 truncate font-mono text-[12px]" title={path}>
          {dir && <span className="text-muted">{dir}</span>}
          <span className="font-semibold text-fg">{name}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {hasChanges && (
            <SegmentedControl
              className="mr-1"
              value={effective}
              label={t('fileViewer.view')}
              options={[
                { value: 'preview', label: t('fileViewer.preview') },
                { value: 'changes', label: t('fileViewer.changes') },
              ]}
              onChange={(next) => onModeChange?.(path, next)}
            />
          )}
          {effective === 'preview' && (
            <>
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
            </>
          )}
          <IconAction label={t('fileTree.reveal')} onClick={reveal}>
            <FolderOpen aria-hidden />
          </IconAction>
          {effective === 'preview' && content?.kind === 'text' && (
            <CopyButton text={text} className="hover:bg-hover hover:text-fg" />
          )}
        </span>
      </div>

      {effective === 'changes' && source.status === 'session' && (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          <FileDiff
            sessionId={sessionId ?? view?.sessionId ?? ''}
            entry={source.entry}
            canRevert={canRevert}
          />
        </div>
      )}
      {effective === 'changes' && source.status === 'changeSet' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-3">
          <div className="flex flex-wrap items-center gap-2 pb-2 text-note">
            <FileStatusBadge status={source.file.status} />
            <span className="text-muted">{t('fileViewer.source.changeSet')}</span>
            {changeSet !== undefined && (
              <button
                type="button"
                onClick={() => onOpenChangeSet?.(changeSet.changeSetId)}
                disabled={onOpenChangeSet === undefined}
                className="ml-auto shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] text-accent outline-none hover:bg-accent-soft focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
              >
                {t('fileViewer.openChangeSet')}
              </button>
            )}
          </div>
          {source.additional > 0 && (
            <p className="pb-2 text-note text-muted">
              {t('fileViewer.additionalChangeSets', { count: source.additional })}
            </p>
          )}
          <DiffCard
            className="my-0"
            path={source.file.path}
            kind={changeSetFileKind(source.file.kind)}
            language={languageForPath(source.file.path)}
            content={changeSetDiffContent(source.file)}
            added={source.file.added}
            removed={source.file.removed}
          />
        </div>
      )}
      {effective === 'changes' && source.status === 'loading' && (
        <p role="status" className="flex items-center gap-2 px-4 py-3 text-note text-muted">
          <Spinner className="size-3.5" />
          {t('fileViewer.loading')}
        </p>
      )}
      {(waiting || (showPreview && state.status === 'loading')) && (
        <p role="status" className="flex items-center gap-2 px-4 py-3 text-note text-muted">
          <Spinner className="size-3.5" />
          {t('fileViewer.loading')}
        </p>
      )}
      {showPreview && state.status === 'error' && (
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
      )}
      {showPreview && content?.kind === 'binary' && (
        <PanelEmpty icon={<TriangleAlert />} hint={formatBytes(content.size)} className="px-4">
          {t('fileViewer.binary')}
        </PanelEmpty>
      )}
      {showPreview && content?.kind === 'too_large' && (
        <PanelEmpty icon={<TriangleAlert />} hint={formatBytes(content.size)} className="px-4">
          {t('fileViewer.tooLarge')}
        </PanelEmpty>
      )}
      {showPreview && content?.kind === 'text' && displayText === '' && (
        <PanelEmpty className="px-4">{t('fileViewer.empty')}</PanelEmpty>
      )}
      {showPreview &&
        state.status === 'ready' &&
        content?.kind === 'text' &&
        displayText !== '' && (
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
                    className={cn(
                      'tabular shrink-0 pr-4 text-right text-gutter select-none',
                      gutter,
                    )}
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
