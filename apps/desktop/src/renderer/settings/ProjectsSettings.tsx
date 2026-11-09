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
import { SettingsCard, SettingsEmpty, ToggleRow } from './Field.js'
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
  const skills = project.enableProjectSkills !== false
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
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-sunk text-fg2 shadow-hair"
          >
            <FolderOpen className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <input
              aria-label={t('projects.name')}
              className="-mx-1.5 h-8 w-full min-w-0 rounded-[7px] bg-transparent px-1.5 text-[15px] font-semibold text-fg outline-none transition-colors hover:bg-paper focus:bg-paper focus:shadow-[inset_0_0_0_0.5px_var(--hair2),0_0_0_3px_var(--accent-soft)]"
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
              className="mt-0.5 truncate font-mono text-[12px] [font-variant-ligatures:none] text-muted"
            >
              {project.path}
            </p>
            <p className="mt-1 text-note text-faint">
              {t('projects.meta', {
                count: project.sessionCount ?? 0,
                when: formatWhen(i18n.language, when),
              })}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-4 border-t-[0.5px] border-hair pt-4">
          <ToggleRow title={t('projects.readAgentsMd')} hint={t('projects.readAgentsMd.hint')}>
            <Switch
              checked={readAgentsMd}
              aria-label={t('projects.readAgentsMd')}
              onCheckedChange={(checked) =>
                void updateProject(project.projectId, { readAgentsMd: checked })
              }
            />
          </ToggleRow>
          <ToggleRow title={t('projects.skills')} hint={t('projects.skills.hint')}>
            <Switch
              checked={skills}
              aria-label={t('projects.skills')}
              onCheckedChange={(checked) =>
                void updateProject(project.projectId, { enableProjectSkills: checked })
              }
            />
          </ToggleRow>
        </div>
        <div>
          <Button
            variant="ghost"
            size="sm"
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
        icon={<FolderOpen />}
        title={t('section.projects.title')}
        description={t('section.projects.description')}
      />
      {projects.length === 0 ? (
        <SettingsEmpty
          icon={<FolderOpen />}
          title={t('projects.emptyTitle')}
          description={t('projects.empty')}
        />
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
