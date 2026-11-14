/**
 * 设置页“已归档的对话”（M3-13）：把归档的会话集中列出来，可以取消归档或彻底删除。
 *
 * 侧栏默认不显示归档的会话，这里是它们的去处：列表从主进程按 `includeArchived` 读一次，
 * 取消归档或删除之后重新读取。彻底删除不可恢复，删除前先确认。
 */
import { Archive, ArchiveRestore, Trash2, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@cairn/protocol'
import { getMainApi } from '../api.js'
import { formatSessionTime } from '../SessionList.js'
import { lastSegment } from '../paths.js'
import { projectDisplayName } from '../project-name.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Spinner,
} from '../ui/index.js'
import { SettingsCard, SettingsEmpty } from './Field.js'
import { SettingsHeader } from './SettingsPage.js'

export function ArchivedSessionsSettings() {
  const { t } = useTranslation('settings')
  const { t: ts } = useTranslation('session')
  const { t: tc } = useTranslation()
  const projects = useSessionStore((s) => s.projects)
  const unarchiveSession = useSessionStore((s) => s.unarchiveSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | undefined>()
  const [deleting, setDeleting] = useState<SessionSummary | undefined>()

  const load = useCallback(async () => {
    const api = getMainApi()
    if (!api) {
      setLoading(false)
      return
    }
    const result = await api.request('session.list', { includeArchived: true })
    setSessions(result.sessions.filter((session) => session.status === 'archived'))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const restore = async (sessionId: string) => {
    setPending(sessionId)
    await unarchiveSession(sessionId)
    setPending(undefined)
    await load()
  }

  const remove = async (sessionId: string) => {
    setPending(sessionId)
    await deleteSession(sessionId)
    setPending(undefined)
    await load()
  }

  return (
    <>
      <SettingsHeader
        icon={<Archive />}
        title={t('section.archived.title')}
        description={t('section.archived.description')}
      />
      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted">
          <Spinner className="size-4" />
        </div>
      ) : sessions.length === 0 ? (
        <SettingsEmpty
          icon={<Archive />}
          title={t('archived.empty.title')}
          description={t('archived.empty.description')}
        />
      ) : (
        <SettingsCard className="gap-0 p-0">
          <ul className="flex flex-col">
            {sessions.map((session, index) => {
              const project = projects.find((item) => item.path === session.projectPath)
              const name = project
                ? projectDisplayName(project, tc('project.defaultName'))
                : lastSegment(session.projectPath)
              const title = session.title === '' ? ts('title.untitled') : session.title
              const time = formatSessionTime(session.updatedAt, ts('list.yesterday'))
              return (
                <li
                  key={session.sessionId}
                  className={`flex min-w-0 items-center gap-3 px-5 py-3 ${
                    index === 0 ? '' : 'border-t border-hair'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui text-fg">{title}</p>
                    <p className="mt-0.5 truncate text-note text-muted">
                      {name}
                      {time !== '' && <span className="text-faint"> · {time}</span>}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending === session.sessionId}
                    onClick={() => void restore(session.sessionId)}
                  >
                    <ArchiveRestore />
                    {t('archived.restore')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger hover:text-danger"
                    disabled={pending === session.sessionId}
                    onClick={() => setDeleting(session)}
                  >
                    <Trash2 />
                    {t('archived.delete')}
                  </Button>
                </li>
              )
            })}
          </ul>
        </SettingsCard>
      )}
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>
            {t('archived.deleteConfirm.title', {
              title: deleting?.title === '' ? ts('title.untitled') : (deleting?.title ?? ''),
            })}
          </DialogTitle>
          <DialogDescription>{t('archived.deleteConfirm.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="danger"
              onClick={() => {
                const target = deleting
                setDeleting(undefined)
                if (target) void remove(target.sessionId)
              }}
            >
              {t('archived.deleteConfirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
