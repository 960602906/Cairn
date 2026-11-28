/**
 * 工作空间 / Git 分支选择：输入框卡片工具栏里的一个下拉控件。
 *
 * 新对话页（传了 `onSelectProject`）的触发器显示「工作空间 · 分支」，菜单上半部分切换工作空间
 * （含「选择文件夹…」），下半部分切换分支；对话页的项目已在顶栏面包屑里，这里只显示分支。
 * 分支由主进程读取，不是 Git 仓库或读取失败时只保留工作空间，对话页则整个控件不出现，免得在
 * 输入框下方留一行悬空的文字。窗口重新获得焦点时刷新一次，用户在外面的终端切换分支后回来即
 * 可看到。切换失败在控件旁显示错误；选中工作空间 / 分支或按 Esc 关闭菜单后把焦点还给调用方。
 */
import { Check, ChevronDown, FolderOpen, GitBranch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import { RpcError, type ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { FolderTypeIcon } from './file-icons.js'
import { onIdle } from './idle.js'
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
  /** 可切换的工作空间（新对话页）；不传时只显示分支（对话页）。 */
  readonly projects?: readonly ProjectSummary[] | undefined
  readonly onSelectProject?: ((path: string) => void) | undefined
  readonly onOpenFolder?: (() => void) | undefined
  /** 选中工作空间或分支、按 Esc 关闭菜单后把焦点还给这里（通常是输入框）。 */
  readonly returnFocus?: (() => void) | undefined
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
  returnFocus,
}: WorkspaceGitBarProps) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const [info, setInfo] = useState<GitInfo>({})
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
  const branch = info.branch
  const interactedOutside = useRef(false)

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
    // 分支读取会 spawn 两个 git 进程：首帧之后再做，切回窗口时仍立即刷新。
    const cancel = onIdle(load, 800)
    window.addEventListener('focus', load)
    return () => {
      live = false
      cancel()
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
  // 对话页的项目在顶栏面包屑里，不在这里重复；没有分支时整个控件不出现。
  if (!switchable && branch === undefined) return null

  const workspaceName = projectNameForPath(projectPath, projects ?? [], tc('project.defaultName'))
  const workspaceLabel =
    workspaceName ?? (projectPath === undefined ? t('new.chooseWorkspace') : '')
  const label = switchable
    ? projectPath === undefined
      ? t('new.chooseWorkspace')
      : branch === undefined
        ? t('new.workspaceLabel', { name: workspaceLabel })
        : t('composer.workspace.workspaceAndBranch', { name: workspaceLabel, branch })
    : t('composer.workspace.branch', { branch: branch ?? '' })

  return (
    <div
      role="group"
      aria-label={t('composer.workspace.label')}
      className="flex min-w-0 items-center gap-1"
    >
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) interactedOutside.current = false
        }}
      >
        <DropdownMenuTrigger
          disabled={switching}
          aria-label={label}
          title={projectPath}
          className="flex h-7 max-w-[240px] min-w-0 items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
        >
          {switchable ? (
            <FolderTypeIcon
              name={projectPath === undefined ? workspaceLabel : lastSegment(projectPath)}
            />
          ) : (
            <GitBranch aria-hidden className="shrink-0 text-muted" />
          )}
          {switchable && <span className="truncate">{workspaceLabel}</span>}
          {branch !== undefined && (
            <>
              {switchable && (
                <span aria-hidden className="text-faint">
                  ·
                </span>
              )}
              <span className="max-w-[160px] truncate text-muted">{branch}</span>
            </>
          )}
          <ChevronDown aria-hidden className="shrink-0 text-faint" />
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
          {switchable && (
            <>
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
            </>
          )}
          {branch !== undefined && (
            <>
              {switchable && <DropdownMenuSeparator />}
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
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error !== '' && (
        <span
          role="alert"
          title={error}
          className="min-w-0 max-w-[180px] truncate text-note text-danger"
        >
          {error}
        </span>
      )}
    </div>
  )
}
