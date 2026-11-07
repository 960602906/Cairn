/**
 * 设置页“项目”（M3-02，general 组）：已打开的项目，可以改名、开关项目说明和项目内技能，
 * 或从列表移除。移除不删除目录，也不删除已有会话。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, TriangleAlert } from 'lucide-react'
import { PROJECT_NAME_MAX_LENGTH, type ProjectSummary } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Switch,
} from '../ui/index.js'
import { SettingsCard } from './Field.js'
import { SettingsHeader } from './SettingsPage.js'

function formatWhen(locale: string, ms: number): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

function ProjectCard({ project }: { readonly project: ProjectSummary }) {
  const { t, i18n } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const updateProject = useSessionStore((s) => s.updateProject)
  const removeProject = useSessionStore((s) => s.removeProject)
  const [name, setName] = useState(project.name)
  const [confirming, setConfirming] = useState(false)
  const readAgentsMd = project.readAgentsMd !== false
  const skills = project.enableProjectSkills === true
  const when = project.lastUsedAt ?? project.createdAt

  const saveName = () => {
    const next = name.trim()
    if (next === project.name) {
      setName(project.name)
      return
    }
    if (next === '') {
      setName(project.name)
      return
    }
    void updateProject(project.projectId, { name: next }).then((saved) => {
      if (!saved) setName(project.name)
    })
  }

  return (
    <li>
      <SettingsCard aria-label={project.name}>
        <input
          aria-label={t('projects.name')}
          className="h-[34px] w-full min-w-0 rounded-[9px] bg-paper px-2.5 text-[15px] font-medium text-fg shadow-[inset_0_0_0_1px_var(--hair2)] outline-none focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]"
          value={name}
          maxLength={PROJECT_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <p
          title={project.path}
          className="truncate font-mono text-[12px] [font-variant-ligatures:none] text-muted"
        >
          {project.path}
        </p>
        <p className="text-note text-muted">
          {t('projects.meta', {
            count: project.sessionCount ?? 0,
            when: formatWhen(i18n.language, when),
          })}
        </p>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-fg">{t('projects.readAgentsMd')}</p>
            <p className="mt-0.5 text-note text-muted">{t('projects.readAgentsMd.hint')}</p>
          </div>
          <Switch
            checked={readAgentsMd}
            aria-label={t('projects.readAgentsMd')}
            onCheckedChange={(checked) =>
              void updateProject(project.projectId, { readAgentsMd: checked })
            }
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-fg">{t('projects.skills')}</p>
            <p className="mt-0.5 text-note text-muted">{t('projects.skills.hint')}</p>
          </div>
          <Switch
            checked={skills}
            aria-label={t('projects.skills')}
            onCheckedChange={(checked) =>
              void updateProject(project.projectId, { enableProjectSkills: checked })
            }
          />
        </div>
        <div>
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            onClick={() => setConfirming(true)}
          >
            {t('projects.remove')}
          </Button>
        </div>
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent tone="danger" icon={<TriangleAlert />}>
            <DialogTitle>{t('projects.remove.title', { name: project.name })}</DialogTitle>
            <DialogDescription>{t('projects.remove.description')}</DialogDescription>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.cancel')}</Button>
              </DialogClose>
              <Button
                size="lg"
                variant="danger"
                onClick={() => {
                  setConfirming(false)
                  void removeProject(project.projectId)
                }}
              >
                {t('projects.remove.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsCard>
    </li>
  )
}

export function ProjectsSettings() {
  const { t } = useTranslation('settings')
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])
  return (
    <>
      <SettingsHeader
        title={t('section.projects.title')}
        description={t('section.projects.description')}
      />
      {projects.length === 0 ? (
        <SettingsCard className="items-start">
          <FolderOpen className="size-4 text-muted" />
          <p className="text-ui text-muted">{t('projects.empty')}</p>
        </SettingsCard>
      ) : (
        <ul aria-label={t('projects.list')} className="flex flex-col gap-3">
          {projects.map((project) => (
            <ProjectCard key={project.projectId} project={project} />
          ))}
        </ul>
      )}
    </>
  )
}
