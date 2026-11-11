/**
 * 改动集审阅（M4-10，管理界面 §8.2、§9）：合并前看清子 Agent 改了什么，并安全地接受或拒绝。
 *
 * - 头部显示来源 Agent、任务、基线快照时间与冲突数；
 * - 文件列表显示增删行数，展开后复用 `DiffCard`；二进制与过大文件只显示说明；
 * - 待处理文件可以整体或逐个接受 / 拒绝；冲突文件只能保留主工作区、采用子运行或手动处理；
 * - 合并后可以用改动集记录的检查点撤销这次合并。
 */
import { Check, ChevronRight, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationView } from '@cairn/core'
import type { ChangeSetFileInfo, ChangeSetInfo, ChangeSetStatus } from '@cairn/protocol'
import { agentName } from './agents/model.js'
import { changeSetDiffContent, changeSetFileKind } from './change-set-patch.js'
import { ChangeCounts, DiffCard, KindBadge, RatioBlocks } from './DiffCard.js'
import { FileTypeIcon } from './file-icons.js'
import { languageForPath } from './languages.js'
import { useSessionStore } from './store-context.js'
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from './ui/index.js'

const STATUS_TONE: Record<ChangeSetStatus, string> = {
  pending: 'bg-warn-soft text-warn',
  applied: 'bg-ok-soft text-ok',
  rejected: 'bg-danger-soft text-danger',
}

const FILE_TONE: Record<ChangeSetFileInfo['status'], string> = {
  pending: 'bg-sunk2 text-muted',
  accepted: 'bg-ok-soft text-ok',
  rejected: 'bg-danger-soft text-danger',
  conflict: 'bg-warn-soft text-warn',
  manual: 'bg-accent-soft text-accent',
}

function formatTime(value: number, locale: string): string {
  return new Date(value).toLocaleString(locale)
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8)
}

function StatusBadge({ status }: { readonly status: ChangeSetStatus }) {
  const { t } = useTranslation('session')
  return (
    <span className={cn('shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]', STATUS_TONE[status])}>
      {t(`changeset.status.${status}`)}
    </span>
  )
}

function FileStatusBadge({ status }: { readonly status: ChangeSetFileInfo['status'] }) {
  const { t } = useTranslation('session')
  return (
    <span className={cn('shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]', FILE_TONE[status])}>
      {t(`changeset.fileStatus.${status}`)}
    </span>
  )
}

function FileRow({
  file,
  pending,
  busy,
  onAccept,
  onReject,
  onResolve,
}: {
  readonly file: ChangeSetFileInfo
  readonly pending: boolean
  readonly busy: boolean
  readonly onAccept: () => void
  readonly onReject: () => void
  readonly onResolve: (resolution: 'keep-main' | 'take-child' | 'manual') => void
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const content = useMemo(() => changeSetDiffContent(file), [file])
  const kind = changeSetFileKind(file.kind)
  const conflict = file.status === 'conflict'
  const actionable = pending && (file.status === 'pending' || file.status === 'manual')
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/file flex h-9 w-full items-center gap-2 px-3 text-left text-note hover:bg-hover"
      >
        <FileTypeIcon name={file.path} />
        <span className="min-w-0 truncate font-mono text-[12px]" title={file.path}>
          {file.path}
        </span>
        <KindBadge kind={kind} />
        <FileStatusBadge status={file.status} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ChangeCounts added={file.added} removed={file.removed} />
          <RatioBlocks added={file.added} removed={file.removed} />
          <ChevronRight
            aria-hidden
            className={cn('size-3.5 text-faint transition-transform', open && 'rotate-90')}
          />
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {file.binary && (
            <p className="mb-2 rounded-item bg-sunk px-2.5 py-2 text-note text-muted">
              {t('changeset.binaryHint')}
            </p>
          )}
          {file.large && (
            <p className="mb-2 rounded-item bg-sunk px-2.5 py-2 text-note text-muted">
              {t('changeset.largeHint')}
            </p>
          )}
          {file.status === 'manual' && (
            <p className="mb-2 rounded-item bg-accent-soft px-2.5 py-2 text-note text-accent">
              {t('changeset.manualHint')}
            </p>
          )}
          <DiffCard
            className="my-0"
            path={file.path}
            kind={kind}
            language={languageForPath(file.path)}
            content={content}
            added={file.added}
            removed={file.removed}
          />
          {actionable && (
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="primary" disabled={busy} onClick={onAccept}>
                <Check aria-hidden />
                {t('changeset.applyFile')}
              </Button>
              <Button size="sm" disabled={busy} onClick={onReject}>
                <X aria-hidden />
                {t('changeset.rejectFile')}
              </Button>
            </div>
          )}
          {conflict && pending && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="flex items-center gap-1 text-note text-warn">
                <TriangleAlert aria-hidden className="size-3.5" />
                {t('changeset.conflict.hint')}
              </span>
              <Button size="sm" disabled={busy} onClick={() => onResolve('keep-main')}>
                {t('changeset.conflict.keepMain')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onResolve('take-child')}>
                {t('changeset.conflict.takeChild')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve('manual')}>
                {t('changeset.conflict.manual')}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function Summary({
  changeSet,
  delegation,
}: {
  readonly changeSet: ChangeSetInfo
  readonly delegation: DelegationView | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const agents = useSessionStore((state) => state.agents) ?? []
  const agent = delegation
    ? (agents.find((item) => item.agentId === delegation.agent.id) ?? undefined)
    : undefined
  const name = delegation
    ? agent
      ? agentName(agent, i18n.language)
      : delegation.agent.id === 'builtin.coder'
        ? t('composer.agent.default')
        : delegation.agent.id
    : changeSet.runId
  const added = changeSet.files.reduce((sum, file) => sum + file.added, 0)
  const removed = changeSet.files.reduce((sum, file) => sum + file.removed, 0)
  const baselineAt = changeSet.baseCreatedAt ?? changeSet.createdAt
  return (
    <div className="flex flex-col gap-2 border-b-[0.5px] border-hair px-3 py-3">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-ui font-medium text-fg">
          {t('changeset.title')}
        </h3>
        <StatusBadge status={changeSet.status} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-note">
        <dt className="text-muted">{t('changeset.source')}</dt>
        <dd className="min-w-0 truncate text-fg2">{name}</dd>
        {delegation && (
          <>
            <dt className="text-muted">{t('changeset.task')}</dt>
            <dd className="line-clamp-2 text-fg2">{delegation.task}</dd>
          </>
        )}
        <dt className="text-muted">{t('changeset.baseline')}</dt>
        <dd className="text-fg2">
          <time dateTime={new Date(baselineAt).toISOString()}>
            {formatTime(baselineAt, i18n.language)}
          </time>
          <span className="ml-1 text-muted">· {shortCommit(changeSet.baseCommit)}</span>
        </dd>
        <dt className="text-muted">{t('changeset.files')}</dt>
        <dd className="flex flex-wrap items-center gap-2 text-fg2">
          <span>{t('changeset.fileCount', { count: changeSet.files.length })}</span>
          <ChangeCounts added={added} removed={removed} />
          {changeSet.conflicts > 0 && (
            <span className="text-warn">
              {t('changeset.conflictCount', { count: changeSet.conflicts })}
            </span>
          )}
        </dd>
      </dl>
    </div>
  )
}

export function ChangeSetReview({
  sessionId,
  changeSetId,
  delegation,
  onBack,
}: {
  readonly sessionId: string
  readonly changeSetId: string
  readonly delegation?: DelegationView | undefined
  readonly onBack?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const detail = useSessionStore((state) => state.changeSetDetails?.[changeSetId])
  const loading = useSessionStore((state) => state.changeSetLoading?.[changeSetId] === true)
  const error = useSessionStore((state) => state.changeSetErrors?.[changeSetId])
  const loadChangeSet = useSessionStore((state) => state.loadChangeSet)
  const applyChangeSet = useSessionStore((state) => state.applyChangeSet)
  const rejectChangeSet = useSessionStore((state) => state.rejectChangeSet)
  const resolveConflict = useSessionStore((state) => state.resolveChangeSetConflict)
  const restoreCheckpoint = useSessionStore((state) => state.restoreCheckpoint)
  const [busy, setBusy] = useState<string>()
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    setRestored(false)
    void loadChangeSet(sessionId, changeSetId)
  }, [changeSetId, loadChangeSet, sessionId])

  const files = detail?.files ?? []
  const pending = detail?.status === 'pending'
  const actionable = files.filter((file) => file.status === 'pending' || file.status === 'manual')
  const canApply = pending && (actionable.length > 0 || files.length === 0)
  const canReject = pending && files.some((file) => file.status !== 'rejected')

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy !== undefined) return
    setBusy(key)
    try {
      await action()
    } finally {
      setBusy(undefined)
    }
  }

  const restore = () =>
    run('restore', async () => {
      if (detail?.checkpointCommit === undefined) return
      const plan = await restoreCheckpoint(sessionId, detail.checkpointCommit)
      if (plan) setRestored(true)
      setConfirmRestore(false)
    })

  return (
    <section aria-label={t('changeset.label')} className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b-[0.5px] border-hair px-3 text-note">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] text-accent outline-none hover:bg-accent-soft focus-visible:ring-1 focus-visible:ring-accent"
          >
            {t('changeset.back')}
          </button>
        )}
        <h3 className="min-w-0 flex-1 truncate font-medium text-fg">{t('changeset.title')}</h3>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {error ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-3 text-ui">
            <p className="text-danger">{t('changeset.error')}</p>
            <Button size="sm" onClick={() => void loadChangeSet(sessionId, changeSetId)}>
              {t('changeset.retry')}
            </Button>
          </div>
        ) : detail === undefined || loading ? (
          <p role="status" className="p-3 text-ui text-muted">
            {t('changeset.loading')}
          </p>
        ) : (
          <>
            <Summary changeSet={detail} delegation={delegation} />
            {pending && (
              <div className="flex flex-wrap items-center gap-1.5 border-b-[0.5px] border-hair px-3 py-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!canApply || busy !== undefined}
                  onClick={() =>
                    void run('apply-all', () =>
                      applyChangeSet(
                        sessionId,
                        changeSetId,
                        actionable.length > 0 ? actionable.map((file) => file.path) : undefined,
                      ),
                    )
                  }
                >
                  <Check aria-hidden />
                  {t('changeset.applyAll')}
                </Button>
                <Button
                  size="sm"
                  disabled={!canReject || busy !== undefined}
                  onClick={() =>
                    void run('reject-all', () => rejectChangeSet(sessionId, changeSetId))
                  }
                >
                  <X aria-hidden />
                  {t('changeset.rejectAll')}
                </Button>
              </div>
            )}
            {files.length === 0 ? (
              <p className="px-4 py-3 text-ui text-muted">{t('changeset.noFiles')}</p>
            ) : (
              <ul className="divide-y-[0.5px] divide-hair">
                {files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    pending={pending}
                    busy={busy !== undefined}
                    onAccept={() =>
                      void run(`accept:${file.path}`, () =>
                        applyChangeSet(sessionId, changeSetId, [file.path]),
                      )
                    }
                    onReject={() =>
                      void run(`reject:${file.path}`, () =>
                        rejectChangeSet(sessionId, changeSetId, [file.path]),
                      )
                    }
                    onResolve={(resolution) =>
                      void run(`resolve:${file.path}`, () =>
                        resolveConflict(sessionId, changeSetId, file.path, resolution),
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {detail.checkpointCommit !== undefined && detail.status === 'applied' && (
              <div className="mt-3 flex flex-col gap-2 rounded-card bg-sunk px-3 py-2.5 text-note">
                <p className="text-fg2">
                  {t('changeset.checkpoint', { commit: shortCommit(detail.checkpointCommit) })}
                </p>
                {restored ? (
                  <p className="text-ok">{t('changeset.undone')}</p>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy !== undefined}
                    onClick={() => setConfirmRestore(true)}
                  >
                    <RotateCcw aria-hidden />
                    {t('changeset.undoMerge')}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <Dialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>{t('changeset.undoTitle')}</DialogTitle>
          <DialogDescription>{t('changeset.undoDescription')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t('changeset.cancel')}</Button>
            </DialogClose>
            <Button variant="danger" disabled={busy !== undefined} onClick={() => void restore()}>
              {t('changeset.undoMerge')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
