/**
 * 新建工作空间：先选择“打开本地文件夹”或“克隆 Git 仓库”。
 *
 * 打开文件夹复用 `project.open`；克隆由主进程在所选父目录下执行，成功后刷新工作区列表。
 * 克隆表单沿用 LiveAgent 的最小字段集合：仓库地址、保存位置、名称与可选分支。
 */
import { ArrowLeft, FolderOpen, GitBranch, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import { PROJECT_NAME_MAX_LENGTH, RpcError, type ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { useSessionStore } from './store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Spinner,
} from './ui/index.js'

const field =
  'h-9 w-full rounded-item bg-raise px-3 text-ui text-fg shadow-hair2 outline-none placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)] disabled:opacity-60'
const labelText = 'mb-1.5 block text-note font-medium text-fg2'

function workspaceNameFromRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  return (
    value
      .split(/[/:\\]/)
      .filter(Boolean)
      .at(-1) ?? ''
  ).slice(0, PROJECT_NAME_MAX_LENGTH)
}

function choiceCardClass(): string {
  return 'flex w-full items-start gap-3 rounded-card bg-sunk/65 px-4 py-3.5 text-left text-fg transition-colors hover:bg-sunk disabled:pointer-events-none disabled:opacity-50'
}

export function WorkspaceCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onCreated?: ((project: ProjectSummary) => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const openProject = useSessionStore((s) => s.openProject)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const [step, setStep] = useState<'choose' | 'clone'>('choose')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [nameIsAutomatic, setNameIsAutomatic] = useState(true)
  const [busy, setBusy] = useState<'folder' | 'parent' | 'clone' | undefined>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setStep('choose')
    setRemoteUrl('')
    setParent('')
    setName('')
    setBranch('')
    setNameIsAutomatic(true)
    setBusy(undefined)
    setError('')
  }, [open])

  const requestClose = (next: boolean) => {
    if (!next && busy !== undefined) return
    onOpenChange(next)
  }

  const describeError = (reason: unknown): string => {
    if (reason instanceof RpcError) return translateError(i18n, reason.toInfo())
    return t('workspace.create.failed')
  }

  const chooseFolder = async () => {
    if (busy !== undefined) return
    setBusy('folder')
    setError('')
    try {
      const project = await openProject()
      if (project) {
        onCreated?.(project)
        onOpenChange(false)
      }
    } finally {
      setBusy(undefined)
    }
  }

  const chooseParent = async () => {
    if (busy !== undefined) return
    const api = getMainApi()
    if (!api) return
    setBusy('parent')
    setError('')
    try {
      const result = await api.request('project.pickDirectory', {})
      if (result.path) setParent(result.path)
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const canClone =
    busy === undefined && remoteUrl.trim() !== '' && parent.trim() !== '' && name.trim() !== ''

  const clone = async (event: FormEvent) => {
    event.preventDefault()
    if (!canClone) return
    const api = getMainApi()
    if (!api) return
    setBusy('clone')
    setError('')
    try {
      const result = await api.request('project.clone', {
        remoteUrl: remoteUrl.trim(),
        parentPath: parent.trim(),
        name: name.trim(),
        ...(branch.trim() === '' ? {} : { branch: branch.trim() }),
      })
      await refreshProjects()
      onCreated?.(result.project)
      onOpenChange(false)
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))]">
        <DialogClose asChild>
          <button
            type="button"
            aria-label={tc('action.close')}
            className="absolute top-4 right-4 inline-flex size-7 items-center justify-center rounded-[7px] text-muted hover:bg-hover hover:text-fg [&_svg]:size-4"
          >
            <X />
          </button>
        </DialogClose>
        <DialogTitle>
          {t(step === 'choose' ? 'workspace.create.title' : 'workspace.create.clone')}
        </DialogTitle>
        <DialogDescription>
          {t(
            step === 'choose'
              ? 'workspace.create.description'
              : 'workspace.create.cloneDescription',
          )}
        </DialogDescription>

        {step === 'choose' ? (
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              disabled={busy !== undefined}
              className={choiceCardClass()}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block text-ui font-medium">
                  {t('workspace.create.openFolder')}
                </span>
                <span className="mt-1 block text-note text-muted">
                  {t('workspace.create.openFolderDescription')}
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={busy !== undefined}
              className={choiceCardClass()}
              onClick={() => {
                setStep('clone')
                setError('')
              }}
            >
              <GitBranch aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block text-ui font-medium">{t('workspace.create.clone')}</span>
                <span className="mt-1 block text-note text-muted">
                  {t('workspace.create.cloneDescription')}
                </span>
              </span>
            </button>
            {error !== '' && (
              <p role="alert" className="text-note text-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={(event) => void clone(event)}>
            <fieldset disabled={busy !== undefined} className="mt-5 min-w-0">
              <label className="mb-3 block">
                <span className={labelText}>{t('workspace.create.cloneUrl')}</span>
                <input
                  className={field}
                  value={remoteUrl}
                  onChange={(event) => {
                    const next = event.target.value
                    setRemoteUrl(next)
                    if (nameIsAutomatic) setName(workspaceNameFromRemoteUrl(next))
                  }}
                  placeholder={t('workspace.create.cloneUrlPlaceholder')}
                  autoComplete="off"
                  autoFocus
                />
              </label>
              <label className="mb-3 block">
                <span className={labelText}>{t('workspace.create.cloneParent')}</span>
                <span className="flex gap-2">
                  <input
                    className={`${field} font-mono text-[12.5px]`}
                    value={parent}
                    readOnly
                    placeholder={t('workspace.create.cloneParentPlaceholder')}
                  />
                  <Button
                    className="h-9 shrink-0"
                    variant="secondary"
                    onClick={() => void chooseParent()}
                  >
                    <FolderOpen />
                    {t('workspace.create.chooseParent')}
                  </Button>
                </span>
              </label>
              <label className="mb-3 block">
                <span className={labelText}>{t('workspace.create.cloneName')}</span>
                <input
                  className={field}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setNameIsAutomatic(false)
                  }}
                  placeholder={t('workspace.create.cloneNamePlaceholder')}
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className={labelText}>{t('workspace.create.cloneBranch')}</span>
                <input
                  className={field}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder={t('workspace.create.cloneBranchPlaceholder')}
                  autoComplete="off"
                />
              </label>
            </fieldset>
            {error !== '' && (
              <p role="alert" className="mt-3 text-note text-danger">
                {error}
              </p>
            )}
            <div className="mt-6 flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setStep('choose')
                  setError('')
                }}
                disabled={busy !== undefined}
              >
                <ArrowLeft />
                {t('workspace.create.back')}
              </Button>
              <span className="ml-auto flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => requestClose(false)}
                  disabled={busy !== undefined}
                >
                  {tc('action.cancel')}
                </Button>
                <Button type="submit" variant="primary" disabled={!canClone}>
                  {busy === 'clone' && <Spinner className="text-ink-fg" />}
                  {busy === 'clone'
                    ? t('workspace.create.cloning')
                    : t('workspace.create.cloneSubmit')}
                </Button>
              </span>
            </div>
          </form>
        )}

        {step === 'choose' && (
          <div className="mt-6 flex justify-end">
            <Button variant="secondary" onClick={() => requestClose(false)}>
              {tc('action.cancel')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
