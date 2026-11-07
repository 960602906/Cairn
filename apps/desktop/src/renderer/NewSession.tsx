/**
 * 新对话（M0-15b 的新建表单，M2-02 起显示在纸面上）：选择项目目录，可以用系统的选择文件夹对话框、
 * 最近打开过的项目，或直接填写完整路径；标题可选。创建成功后切到新会话。
 *
 * 空状态（M2-12）：还没有配置模型供应商时，表单上方提示先去设置添加；还没有打开过项目时，说明换成引导选择
 * 文件夹，“选择文件夹…”在填写路径之前是主按钮。
 */
import { Cpu, FolderOpen } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'
import { Button } from './ui/index.js'

const field =
  'h-9 w-full rounded-item bg-raise px-3 text-ui text-fg shadow-hair2 outline-none placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)]'
const labelText = 'mb-1.5 block text-note font-medium text-fg2'

export function NewSession({
  onDone,
  onSettings,
}: {
  readonly onDone: () => void
  /** 打开设置页的“模型供应商”（没有配置供应商时的引导）。 */
  readonly onSettings?: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const createSession = useSessionStore((s) => s.createSession)
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const openProject = useSessionStore((s) => s.openProject)
  const hasSessions = useSessionStore((s) => s.sessions.length > 0)
  // 设置还没读到时不提示（旧版主进程或测试替身可能不返回供应商列表）
  const noProvider = useSessionStore((s) => s.settings?.providers?.length === 0)
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '')
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
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-7 pt-[12vh] pb-10">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-[520px]">
        {noProvider && (
          <section
            aria-label={t('new.noProvider.title')}
            className="mb-8 flex items-start gap-3 rounded-card bg-sunk px-4 py-3.5"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-raise text-fg2 shadow-1 [&_svg]:size-4">
              <Cpu />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-medium text-fg">{t('new.noProvider.title')}</span>
              <span className="mt-0.5 block text-note text-muted">
                {t('new.noProvider.description')}
              </span>
            </span>
            {onSettings && (
              <Button variant="primary" className="shrink-0" onClick={onSettings}>
                {t('new.noProvider.action')}
              </Button>
            )}
          </section>
        )}
        <h2 className="text-page">{t('new.heading')}</h2>
        <p className="mt-1.5 mb-7 text-ui text-muted">
          {projects.length === 0 ? t('new.noProject') : t('new.description')}
        </p>

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
              variant={projectPath.trim() === '' ? 'primary' : 'secondary'}
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
          <Button type="submit" variant="primary" disabled={busy || projectPath.trim() === ''}>
            {t('new.create')}
          </Button>
        </div>
      </form>
    </div>
  )
}
