/**
 * 会话列表与新建（M0-15b）。列表来自 store（主进程 `session.list`），状态随事件投影更新。
 * 新建时选择项目目录（M1-16a）：系统的选择文件夹对话框，或最近打开过的项目，也可以直接填写完整路径。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'

function NewSessionForm({ onDone }: { readonly onDone: () => void }) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const createSession = useSessionStore((s) => s.createSession)
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const openProject = useSessionStore((s) => s.openProject)
  const [projectPath, setProjectPath] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const chooseFolder = async () => {
    const project = await openProject()
    if (project) setProjectPath(project.path)
  }

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
      <button type="button" onClick={() => void chooseFolder()}>
        {t('new.openFolder')}
      </button>
      {projects.length > 0 && (
        <label>
          {t('new.recentProjects')}
          <select
            value={projects.some((p) => p.path === projectPath) ? projectPath : ''}
            onChange={(e) => e.target.value !== '' && setProjectPath(e.target.value)}
          >
            <option value="">{t('new.chooseProject')}</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.path}>
                {p.name} — {p.path}
              </option>
            ))}
          </select>
        </label>
      )}
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
