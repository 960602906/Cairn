/**
 * 输入框上方的上下文条：工作空间、Git 分支与分支的常用操作。
 *
 * 新对话页（传了 `onSelectProject`）显示「工作空间 · 分支」两个下拉：工作空间菜单切换项目、
 * 选择文件夹；分支菜单切换分支，并提供新建、拉取（只接受快进）与推送。对话页的项目已在顶栏
 * 面包屑里，这里只保留分支；不是 Git 仓库或读取失败时整条不出现，免得在输入框上方留一行
 * 悬空的文字。窗口重新获得焦点时刷新一次，用户在外面的终端切换分支后回来即可看到。操作结果
 * 以一行 `role="status"` 文字短暂显示，失败显示 Git 的说明。
 */
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import { RpcError, type ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { FolderTypeIcon } from './file-icons.js'
import { onIdle } from './idle.js'
import { lastSegment } from './paths.js'
import { projectDisplayName, projectNameForPath } from './project-name.js'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from './ui/index.js'

/** 成功提示的停留时间；失败提示留到下一次操作。 */
const NOTICE_MS = 2400

const triggerClass =
  'group flex h-6 min-w-0 items-center gap-1.5 rounded-item px-1.5 text-note outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-3.5'

/** 下拉的箭头只在悬停 / 聚焦 / 展开时出现，静止时保持一行干净的文字。 */
const chevronClass =
  'shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100'

const fieldClass =
  'h-9 w-full rounded-item bg-raise px-3 text-ui text-fg shadow-hair2 outline-none placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)] disabled:opacity-60'

export interface WorkspaceGitBarProps {
  readonly projectPath: string | undefined
  /** 可切换的工作空间（新对话页）；不传时只显示分支（对话页）。 */
  readonly projects?: readonly ProjectSummary[] | undefined
  readonly onSelectProject?: ((path: string) => void) | undefined
  readonly onOpenFolder?: (() => void) | undefined
  /** 选中工作空间 / 分支、关闭菜单或新建分支对话框后把焦点还给这里（通常是输入框）。 */
  readonly returnFocus?: (() => void) | undefined
}

interface GitInfo {
  readonly branch?: string | undefined
  readonly branches?: string[] | undefined
  readonly remote?: RemoteKind | undefined
  readonly remoteHost?: string | undefined
}

type RemoteKind = 'github' | 'gitee' | 'git'

/** Simple Icons 的品牌标记（CC0），统一用 currentColor，跟随亮 / 暗主题。 */
const REMOTE_LOGOS: Readonly<Record<RemoteKind, { label: string; path: string }>> = {
  github: {
    label: 'GitHub',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  gitee: {
    label: 'Gitee',
    path: 'M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296Z',
  },
  git: {
    label: 'Git',
    path: 'M13.09 23.549a1.54 1.54 0 0 1-2.18 0L.451 13.089a1.54 1.54 0 0 1 0-2.179l7.191-7.19 2.733 2.733a1.85 1.85 0 0 0 .964 2.326v6.66a1.849 1.849 0 1 0 1.54 0V8.957l2.508 2.508a1.85 1.85 0 1 0 1.09-1.09l-2.634-2.634a1.85 1.85 0 0 0-2.378-2.377L8.73 2.63 10.91.451a1.54 1.54 0 0 1 2.179 0l10.459 10.46a1.54 1.54 0 0 1 0 2.179z',
  },
}

function RemoteLogo({
  remote,
  host,
}: {
  readonly remote: RemoteKind
  readonly host?: string | undefined
}) {
  const { t } = useTranslation('session')
  const logo = REMOTE_LOGOS[remote]
  return (
    <svg
      role="img"
      aria-label={t('composer.workspace.remote', { name: host ?? logo.label })}
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-3.5 shrink-0 text-muted"
    >
      <path d={logo.path} />
    </svg>
  )
}

type Action = 'checkout' | 'create' | 'pull' | 'push'

interface Notice {
  readonly tone: 'ok' | 'error'
  readonly text: string
}

export function WorkspaceGitBar({
  projectPath,
  projects,
  onSelectProject,
  onOpenFolder,
  returnFocus,
}: WorkspaceGitBarProps) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const [info, setInfo] = useState<GitInfo>({})
  const [busy, setBusy] = useState<Action>()
  const [notice, setNotice] = useState<Notice>()
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const branch = info.branch
  const interactedOutside = useRef(false)
  /** 从分支菜单打开新建对话框时不把焦点还给输入框，留给对话框自己的输入框。 */
  const skipReturnFocus = useRef(false)

  useEffect(() => {
    setInfo({})
    setNotice(undefined)
    setCreateOpen(false)
    setCreateName('')
    setCreateError('')
    if (projectPath === undefined) return
    const api = getMainApi()
    if (api === undefined) return
    let live = true
    const update = (value: GitInfo) => {
      if (live) setInfo(value)
    }
    const load = () => {
      void api
        .request('project.gitInfo', { path: projectPath })
        .then(update)
        .catch(() => update({}))
    }
    // 分支读取会 spawn 两个 git 进程：首帧之后再做，切回窗口时仍立即刷新。
    const cancel = onIdle(load, 800)
    window.addEventListener('focus', load)
    return () => {
      live = false
      cancel()
      window.removeEventListener('focus', load)
    }
  }, [projectPath])

  useEffect(() => {
    if (notice?.tone !== 'ok') return
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const describe = (reason: unknown, fallback: string): string =>
    reason instanceof RpcError ? translateError(i18n, reason.toInfo()) : fallback

  const apply = (result: GitInfo) => {
    setInfo((current) => ({ ...current, ...result }))
  }

  const switchTo = async (next: string) => {
    if (projectPath === undefined || next === branch || busy !== undefined) return
    const api = getMainApi()
    if (api === undefined) return
    setBusy('checkout')
    setNotice(undefined)
    try {
      apply(await api.request('project.gitCheckout', { path: projectPath, branch: next }))
    } catch (reason) {
      setNotice({ tone: 'error', text: describe(reason, t('composer.workspace.switchFailed')) })
    } finally {
      setBusy(undefined)
    }
  }

  const pull = async () => {
    if (projectPath === undefined || busy !== undefined) return
    const api = getMainApi()
    if (api === undefined) return
    setBusy('pull')
    setNotice(undefined)
    try {
      apply(await api.request('project.gitPull', { path: projectPath }))
      setNotice({ tone: 'ok', text: t('composer.workspace.pulled') })
    } catch (reason) {
      setNotice({ tone: 'error', text: describe(reason, t('composer.workspace.actionFailed')) })
    } finally {
      setBusy(undefined)
    }
  }

  const push = async () => {
    if (projectPath === undefined || busy !== undefined) return
    const api = getMainApi()
    if (api === undefined) return
    setBusy('push')
    setNotice(undefined)
    try {
      apply(await api.request('project.gitPush', { path: projectPath }))
      setNotice({ tone: 'ok', text: t('composer.workspace.pushed') })
    } catch (reason) {
      setNotice({ tone: 'error', text: describe(reason, t('composer.workspace.actionFailed')) })
    } finally {
      setBusy(undefined)
    }
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    const name = createName.trim()
    if (projectPath === undefined || name === '' || busy !== undefined) return
    const api = getMainApi()
    if (api === undefined) return
    setBusy('create')
    setCreateError('')
    try {
      const result = await api.request('project.gitCreateBranch', {
        path: projectPath,
        branch: name,
      })
      apply({ ...result, branch: result.branch ?? name })
      setCreateOpen(false)
      setCreateName('')
      setNotice({ tone: 'ok', text: t('composer.workspace.created', { branch: name }) })
    } catch (reason) {
      setCreateError(describe(reason, t('composer.workspace.actionFailed')))
    } finally {
      setBusy(undefined)
    }
  }

  const setCreateDialogOpen = (open: boolean) => {
    if (!open && busy === 'create') return
    setCreateOpen(open)
    if (!open) setCreateError('')
  }

  const switchable = onSelectProject !== undefined
  if (projectPath === undefined && !switchable) return null
  // 对话页的项目在顶栏面包屑里，不在这里重复；没有分支时整条不出现。
  if (!switchable && branch === undefined) return null

  const workspaceName = projectNameForPath(projectPath, projects ?? [], tc('project.defaultName'))
  const workspaceLabel =
    workspaceName ?? (projectPath === undefined ? t('new.chooseWorkspace') : '')
  const workspaceAria =
    projectPath === undefined
      ? t('new.chooseWorkspace')
      : t('new.workspaceLabel', { name: workspaceLabel })
  const branches = info.branches ?? (branch === undefined ? [] : [branch])
  const busyText =
    busy === 'pull'
      ? t('composer.workspace.pulling')
      : busy === 'push'
        ? t('composer.workspace.pushing')
        : busy === 'create'
          ? t('composer.workspace.creating')
          : busy === 'checkout'
            ? t('composer.workspace.switching')
            : ''

  return (
    <div
      role="group"
      aria-label={t('composer.workspace.label')}
      aria-busy={busy !== undefined || undefined}
      className="mb-1.5 flex min-w-0 items-center gap-1 px-1"
    >
      {switchable && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) interactedOutside.current = false
          }}
        >
          <DropdownMenuTrigger
            disabled={busy !== undefined}
            aria-label={workspaceAria}
            title={projectPath}
            className={triggerClass}
          >
            <FolderTypeIcon
              name={projectPath === undefined ? workspaceLabel : lastSegment(projectPath)}
            />
            <span className="max-w-[200px] truncate text-fg2">{workspaceLabel}</span>
            <ChevronDown aria-hidden className={chevronClass} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="top"
            className="max-h-80 w-64 overflow-y-auto"
            onInteractOutside={() => {
              interactedOutside.current = true
            }}
            onCloseAutoFocus={(event) => {
              if (returnFocus === undefined || interactedOutside.current) return
              event.preventDefault()
              returnFocus()
            }}
          >
            <DropdownMenuLabel>{t('composer.workspace.switch')}</DropdownMenuLabel>
            {(projects ?? []).map((project) => (
              <DropdownMenuItem
                key={project.projectId}
                onSelect={() => onSelectProject?.(project.path)}
              >
                <FolderTypeIcon name={lastSegment(project.path)} />
                <span className="min-w-0 flex-1 truncate">
                  {projectDisplayName(project, tc('project.defaultName'))}
                </span>
                {project.path === projectPath && <Check className="text-fg!" />}
              </DropdownMenuItem>
            ))}
            {(projects ?? []).length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => onOpenFolder?.()}>
              <FolderOpen className="shrink-0" />
              {t('new.openFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {branch !== undefined && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) interactedOutside.current = false
          }}
        >
          <DropdownMenuTrigger
            disabled={busy !== undefined}
            aria-label={t('composer.workspace.branch', { branch })}
            title={branch}
            className={triggerClass}
          >
            <GitBranch aria-hidden className="shrink-0 text-muted" />
            <span className="max-w-[200px] truncate text-muted">{branch}</span>
            <ChevronDown aria-hidden className={chevronClass} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="top"
            className="w-64"
            onInteractOutside={() => {
              interactedOutside.current = true
            }}
            onCloseAutoFocus={(event) => {
              if (skipReturnFocus.current) {
                skipReturnFocus.current = false
                event.preventDefault()
                return
              }
              if (returnFocus === undefined || interactedOutside.current) return
              event.preventDefault()
              returnFocus()
            }}
          >
            {/* 「切换分支」右边是三个 Git 操作，只用图标；悬停与读屏靠 title / aria-label 说明。 */}
            <div className="flex items-center gap-1 py-0.5 pr-1 pl-2">
              <DropdownMenuLabel className="min-w-0 flex-1 truncate px-0 py-0 text-note text-muted">
                {t('composer.workspace.branches')}
              </DropdownMenuLabel>
              {info.remote !== undefined && (
                <RemoteLogo remote={info.remote} host={info.remoteHost} />
              )}
              <DropdownMenuItem
                aria-label={t('composer.workspace.newBranch')}
                title={t('composer.workspace.newBranch')}
                disabled={projectPath === undefined}
                onSelect={() => {
                  skipReturnFocus.current = true
                  setCreateDialogOpen(true)
                }}
                className="size-7 justify-center px-0"
              >
                <GitBranchPlus className="shrink-0" />
              </DropdownMenuItem>
              <DropdownMenuItem
                aria-label={t('composer.workspace.pull')}
                title={t('composer.workspace.pull')}
                disabled={busy !== undefined}
                onSelect={() => void pull()}
                className="size-7 justify-center px-0"
              >
                <ArrowDownToLine className="shrink-0" />
              </DropdownMenuItem>
              <DropdownMenuItem
                aria-label={t('composer.workspace.push')}
                title={t('composer.workspace.push')}
                disabled={busy !== undefined}
                onSelect={() => void push()}
                className="size-7 justify-center px-0"
              >
                <ArrowUpFromLine className="shrink-0" />
              </DropdownMenuItem>
            </div>
            <div className="max-h-52 overflow-y-auto">
              {branches.map((item) => (
                <DropdownMenuItem
                  key={item}
                  disabled={item === branch || busy !== undefined}
                  onSelect={() => void switchTo(item)}
                >
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                  {item === branch && <Check className="text-fg!" />}
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {busyText !== '' && (
        <span role="status" className="min-w-0 truncate text-note text-muted">
          {busyText}
        </span>
      )}
      {busyText === '' && notice !== undefined && (
        <span
          role={notice.tone === 'error' ? 'alert' : 'status'}
          title={notice.text}
          className={cn(
            'min-w-0 flex-1 truncate text-note',
            notice.tone === 'error' ? 'text-danger' : 'text-ok',
          )}
        >
          {notice.text}
        </span>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (returnFocus === undefined) return
            event.preventDefault()
            returnFocus()
          }}
        >
          <form onSubmit={(event) => void create(event)}>
            <DialogTitle>{t('composer.workspace.createTitle')}</DialogTitle>
            <DialogDescription>
              {t('composer.workspace.createDescription', { branch: branch ?? '' })}
            </DialogDescription>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-note font-medium text-fg2">
                {t('composer.workspace.createName')}
              </span>
              <input
                className={fieldClass}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder={t('composer.workspace.createPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            {createError !== '' && (
              <p role="alert" className="mt-3 text-note text-danger">
                {createError}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setCreateDialogOpen(false)}
                disabled={busy === 'create'}
              >
                {tc('action.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={createName.trim() === '' || busy === 'create'}
              >
                {busy === 'create' && <Spinner className="text-ink-fg" />}
                {busy === 'create'
                  ? t('composer.workspace.creating')
                  : t('composer.workspace.createSubmit')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
