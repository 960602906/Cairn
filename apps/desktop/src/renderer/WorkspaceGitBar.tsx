/**
 * 输入框上方的当前目录与 Git 分支（参考 LiveAgent 的输入区 Git 状态）。
 *
 * 目录显示工作空间名（悬停看完整路径）；分支由主进程读取，点开可以切换到其他本地分支。
 * 不是 Git 仓库或读取失败时只显示目录。窗口重新获得焦点时刷新一次，用户在外面的
 * 终端切换分支后回来即可看到。
 */
import { Check, ChevronDown, Folder, FolderOpen, GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import { RpcError, type ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { lastSegment } from './paths.js'
import { projectDisplayName, projectNameForPath } from './project-name.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/index.js'

export interface WorkspaceGitBarProps {
  readonly projectPath: string | undefined
  /** 可切换的工作空间（新对话页）；不传时只显示目录，不能切换。 */
  readonly projects?: readonly ProjectSummary[] | undefined
  readonly onSelectProject?: ((path: string) => void) | undefined
  readonly onOpenFolder?: (() => void) | undefined
}

interface GitInfo {
  readonly branch?: string | undefined
  readonly branches?: string[] | undefined
}

export function WorkspaceGitBar({
  projectPath,
  projects,
  onSelectProject,
  onOpenFolder,
}: WorkspaceGitBarProps) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const [info, setInfo] = useState<GitInfo>({})
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
  const branch = info.branch

  useEffect(() => {
    setInfo({})
    setError('')
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
    load()
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [projectPath])

  const switchTo = async (next: string) => {
    if (projectPath === undefined || next === branch || switching) return
    const api = getMainApi()
    if (api === undefined) return
    setSwitching(true)
    setError('')
    try {
      const result = await api.request('project.gitCheckout', { path: projectPath, branch: next })
      setInfo((current) => ({ ...current, branch: result.branch ?? next }))
    } catch (reason) {
      setError(
        reason instanceof RpcError
          ? translateError(i18n, reason.toInfo())
          : t('composer.workspace.switchFailed'),
      )
    } finally {
      setSwitching(false)
    }
  }

  const switchable = onSelectProject !== undefined
  if (projectPath === undefined && !switchable) return null
  const workspaceName = projectNameForPath(projectPath, projects ?? [], tc('project.defaultName'))
  const workspaceLabel =
    workspaceName ?? (projectPath === undefined ? t('new.chooseWorkspace') : '')

  const directory = switchable ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          projectPath === undefined
            ? t('new.chooseWorkspace')
            : t('new.workspaceLabel', { name: workspaceLabel })
        }
        title={projectPath}
        className="flex h-6 min-w-0 max-w-[260px] items-center gap-1.5 rounded-item px-1.5 text-note text-muted outline-none hover:bg-hover hover:text-fg2 [&_svg]:size-3.5"
      >
        <Folder aria-hidden className="shrink-0 text-faint" />
        <span className="truncate">{workspaceLabel}</span>
        <ChevronDown aria-hidden className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuLabel>{t('composer.workspace.switch')}</DropdownMenuLabel>
        {(projects ?? []).map((project) => (
          <DropdownMenuItem
            key={project.projectId}
            onSelect={() => onSelectProject?.(project.path)}
          >
            <Folder className="shrink-0" />
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
  ) : projectPath !== undefined ? (
    <span
      title={projectPath}
      aria-label={t('composer.workspace.directory', { path: projectPath })}
      className="flex min-w-0 items-center gap-1.5"
    >
      <Folder aria-hidden className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{lastSegment(projectPath)}</span>
    </span>
  ) : null

  return (
    <div
      role="group"
      aria-label={t('composer.workspace.label')}
      className="mb-1.5 flex min-w-0 items-center gap-3 px-3 text-note text-muted"
    >
      {directory}
      {branch !== undefined && (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={switching}
            title={t('composer.workspace.branch', { branch })}
            aria-label={t('composer.workspace.branch', { branch })}
            className="flex h-6 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-item px-1.5 text-note text-muted outline-none hover:bg-hover hover:text-fg2 disabled:opacity-60 [&_svg]:size-3.5"
          >
            <GitBranch aria-hidden className="shrink-0 text-faint" />
            <span className="truncate">{branch}</span>
            <ChevronDown aria-hidden className="shrink-0 text-faint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="max-h-72 w-56 overflow-y-auto">
            <DropdownMenuLabel>{t('composer.workspace.branches')}</DropdownMenuLabel>
            {(info.branches ?? [branch]).map((item) => (
              <DropdownMenuItem
                key={item}
                disabled={item === branch || switching}
                onSelect={() => void switchTo(item)}
              >
                <span className="min-w-0 flex-1 truncate">{item}</span>
                {item === branch && <Check className="text-fg!" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {error !== '' && (
        <span role="alert" title={error} className="min-w-0 truncate text-danger">
          {error}
        </span>
      )}
    </div>
  )
}
