/**
 * 新对话（M0-15b 的新建表单，M2-02 起显示在纸面上）：选择项目目录，可以用系统的选择文件夹对话框、
 * 最近打开过的项目，或直接填写完整路径；标题可选。创建成功后切到新会话。
 * M2-12：还没有模型供应商时引导去设置；还没有项目时，选择文件夹是主按钮。
 */
import { FolderOpen } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'
import { Button } from './ui/index.js'

const field =
  'h-9 w-full rounded-item bg-raise px-3 text-ui text-fg shadow-hair2 outline-none placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)]'
const labelText = 'mb-1.5 block text-note font-medium text-fg2'

export function NewSession({
  onDone,
  onOpenSettings,
}: {
  readonly onDone: () => void
  readonly onOpenSettings: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const createSession = useSessionStore((s) => s.createSession)
  const projects = useSessionStore((s) => s.projects)
  const settings = useSessionStore((s) => s.settings)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const openProject = useSessionStore((s) => s.openProject)
  const hasSessions = useSessionStore((s) => s.sessions.length > 0)
  const noProviders = Array.isArray(settings?.providers) && settings.providers.length === 0
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  // 项目列表读到之前不显示“还没有项目”，避免先闪一下再消失
  const [projectsKnown, setProjectsKnown] = useState(false)
  const hasPath = projectPath.trim() !== ''

  useEffect(() => {
    let alive = true
    void refreshProjects().finally(() => {
      if (alive) setProjectsKnown(true)
    })
    return () => {
      alive = false
    }
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
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-7 pt-[12vh] pb-10">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-[520px]">
        <h2 className="text-page">{t('new.heading')}</h2>
        <p className="mt-1.5 mb-7 text-ui text-muted">{t('new.description')}</p>

        {noProviders && (
          <div role="status" className="mb-6 rounded-card bg-warn-soft px-4 py-3.5">
            <p className="text-ui font-medium text-fg">{t('empty.providers.title')}</p>
            <p className="mt-1 text-note text-fg2">{t('empty.providers.description')}</p>
            <Button className="mt-3" variant="primary" onClick={onOpenSettings}>
              {t('empty.providers.action')}
            </Button>
          </div>
        )}

        {projectsKnown && projects.length === 0 && (
          <p className="mb-4 text-ui text-fg2">{t('empty.project')}</p>
        )}

        <label className="mb-4 block">
          <span className={labelText}>{t('new.projectPath')}</span>
          <span className="flex gap-2">
            <input
              className={`${field} font-mono text-[12.5px]`}
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder={t('new.projectPathHint')}
              required
            />
            <Button
              className="h-9"
              variant={hasPath ? 'secondary' : 'primary'}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen />
              {t('new.openFolder')}
            </Button>
          </span>
        </label>

        {projects.length > 0 && (
          <label className="mb-4 block">
            <span className={labelText}>{t('new.recentProjects')}</span>
            <select
              className={field}
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

        <label className="mb-7 block">
          <span className={labelText}>{t('new.title')}</span>
          <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="flex justify-end gap-2">
          {hasSessions && (
            <Button variant="ghost" onClick={onDone}>
              {tc('action.cancel')}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={busy || !hasPath}>
            {t('new.create')}
          </Button>
        </div>
      </form>
    </div>
  )
}
