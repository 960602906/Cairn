/**
 * 会话列表与新建（M0-15b）。列表来自 store（主进程 `session.list`），状态随事件投影更新。
 * 新建需要项目目录的完整路径（选择文件夹的对话框在之后接入）。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'

function NewSessionForm({ onDone }: { readonly onDone: () => void }) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const createSession = useSessionStore((s) => s.createSession)
  const [projectPath, setProjectPath] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const path = projectPath.trim()
    if (path === '' || busy) return
    setBusy(true)
    const id = await createSession(path, title.trim() === '' ? undefined : title.trim())
    setBusy(false)
    if (id !== undefined) onDone()
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <label>
        {t('new.projectPath')}
        <input
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder={t('new.projectPathHint')}
          required
        />
      </label>
      <label>
        {t('new.title')}
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <button type="submit" disabled={busy || projectPath.trim() === ''}>
        {t('new.create')}
      </button>
      <button type="button" onClick={onDone}>
        {tc('action.cancel')}
      </button>
    </form>
  )
}

export function SessionList() {
  const { t } = useTranslation('session')
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const refreshSessions = useSessionStore((s) => s.refreshSessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  return (
    <nav aria-labelledby="session-list-title">
      <h2 id="session-list-title">{t('list.title')}</h2>
      {creating ? (
        <NewSessionForm onDone={() => setCreating(false)} />
      ) : (
        <button type="button" onClick={() => setCreating(true)}>
          {t('list.new')}
        </button>
      )}
      {sessions.length === 0 ? (
        <p>{t('list.empty')}</p>
      ) : (
        <ul>
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                aria-current={s.sessionId === activeSessionId ? 'true' : undefined}
                onClick={() => void selectSession(s.sessionId)}
              >
                <span>{s.title === '' ? t('title.untitled') : s.title}</span>
                <span>{t(`status.${s.status}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
