/**
 * 设置页“技能”（M3-08，capabilities 组）：列出内置、本机 `.agents`、已安装和已开启项目的技能。
 *
 * - 每份技能显示来源、描述、约占用多少 token，可以启用、改“始终加载”、查看详情；用户安装的技能可以卸载。
 * - 安装时先用系统对话框选择文件夹或 zip（`skill.pickSource`），主进程只读取并返回预览，确认后才写盘。
 * - 项目内技能只为开启了“启用项目内技能”的项目读取，合并到列表里；内置与已安装的技能只读一次。
 * - 脚本不会自动执行：预览与详情都会标出，执行时仍走审批。
 */
import {
  ChevronRight,
  ChevronDown,
  Cloud,
  Download,
  ExternalLink,
  FileCode2,
  ListChecks,
  Pin,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  HubSkillCard,
  SkillDetail,
  SkillFileInfo,
  SkillInstallSource,
  SkillSummary,
} from '@cairn/protocol'
import { Markdown } from '../Markdown.js'
import { projectDisplayName } from '../project-name.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Spinner,
  Switch,
} from '../ui/index.js'
import { inputClass, SettingsCard, SettingsEmpty } from './Field.js'
import { ListFilter } from './ListFilter.js'
import { SettingsHeader } from './SettingsPage.js'
import { SkillGlyph } from './SettingIcons.js'

type PickKind = SkillInstallSource['kind']

const keyOf = (skill: SkillSummary) => `${skill.source}:${skill.projectId ?? ''}:${skill.name}`

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileList({
  files,
  truncated,
}: {
  readonly files: readonly SkillFileInfo[]
  readonly truncated?: true | undefined
}) {
  const { t } = useTranslation('settings')
  if (files.length === 0) return <p className="text-note text-muted">{t('skills.files.empty')}</p>
  return (
    <>
      <ul className="flex flex-col gap-1">
        {files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-center gap-2 text-[12.5px] text-fg2">
            <span className="truncate font-mono [font-variant-ligatures:none]">{file.path}</span>
            {file.script && (
              <span className="shrink-0 rounded-full bg-sunk2 px-1.5 py-0.5 text-[11px] text-fg2">
                {t('skills.files.script')}
              </span>
            )}
            <span className="ml-auto shrink-0 tabular text-[11.5px] text-faint">
              {formatBytes(file.bytes)}
            </span>
          </li>
        ))}
      </ul>
      {truncated && <p className="mt-1 text-note text-muted">{t('skills.files.truncated')}</p>}
    </>
  )
}

function SkillCard({
  skill,
  source,
  selectionMode = false,
  selected = false,
  onSelect,
  onChanged,
  onOpen,
  onUninstall,
}: {
  readonly skill: SkillSummary
  readonly source: string
  readonly selectionMode?: boolean
  readonly selected?: boolean
  readonly onSelect?: (selected: boolean) => void
  readonly onChanged: () => Promise<void>
  readonly onOpen: (skill: SkillSummary) => void
  readonly onUninstall: (skill: SkillSummary) => void
}) {
  const { t, i18n } = useTranslation('settings')
  const setSkillEnabled = useSessionStore((s) => s.setSkillEnabled)
  const tokens = new Intl.NumberFormat(i18n.language).format(
    !skill.enabled || skill.shadowed ? 0 : skill.pinned ? skill.tokens.pinned : skill.tokens.index,
  )
  const toggle = (patch: { enabled?: boolean; pinned?: boolean }) => {
    void setSkillEnabled({
      name: skill.name,
      source: skill.source,
      ...(skill.projectId !== undefined ? { projectId: skill.projectId } : {}),
      ...patch,
    }).then((updated) => {
      if (updated) void onChanged()
    })
  }
  return (
    <li>
      <SettingsCard
        aria-label={skill.name}
        className={cn(
          'cursor-pointer gap-2 px-4 py-3',
          selected && 'shadow-[0_0_0_1.5px_var(--accent)]',
        )}
        onClick={() => (selectionMode ? onSelect?.(!selected) : onOpen(skill))}
      >
        <div className="flex min-w-0 items-center gap-3">
          {selectionMode && (
            <span className="flex" onClick={(event) => event.stopPropagation()}>
              <Checkbox
                checked={selected}
                aria-label={t('skills.selectAria', { name: skill.name })}
                onChange={(event) => onSelect?.(event.currentTarget.checked)}
              />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-[14px] font-medium text-fg">{skill.name}</p>
              <span className="shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[11px] text-muted">
                {source}
              </span>
              {skill.shadowed && (
                <span
                  title={t('skills.shadowed.hint')}
                  className="shrink-0 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] text-danger"
                >
                  {t('skills.shadowed')}
                </span>
              )}
              {skill.hasScripts && (
                <span className="shrink-0 rounded-full bg-sunk2 px-2 py-0.5 text-[11px] text-fg2">
                  {t('skills.hasScripts')}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <p className="truncate text-[12.5px] text-muted" title={skill.description}>
                {skill.description}
              </p>
              <span className="shrink-0 tabular text-[11.5px] text-faint">
                {t('skills.tokens', { tokens })}
              </span>
            </div>
          </div>
          {!selectionMode && (
            <div
              className="flex shrink-0 items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              <span className="flex items-center gap-1 text-faint" title={t('skills.pinned.hint')}>
                <Pin aria-hidden className="size-3.5" />
                <Switch
                  checked={skill.pinned}
                  aria-label={t('skills.pinnedAria', { name: skill.name })}
                  title={t('skills.pinned')}
                  onCheckedChange={(pinned) => toggle({ pinned })}
                />
              </span>
              <Switch
                checked={skill.enabled}
                aria-label={t('skills.enabledAria', { name: skill.name })}
                title={t('skills.enabled')}
                onCheckedChange={(enabled) => toggle({ enabled })}
              />
              <IconButton
                label={t('skills.detailAria', { name: skill.name })}
                size="icon-sm"
                onClick={() => onOpen(skill)}
              >
                <ChevronRight />
              </IconButton>
              {skill.source === 'user' && (
                <IconButton
                  label={t('skills.uninstallAria', { name: skill.name })}
                  size="icon-sm"
                  className="hover:bg-danger-soft hover:text-danger"
                  onClick={() => onUninstall(skill)}
                >
                  <Trash2 />
                </IconButton>
              )}
            </div>
          )}
        </div>
      </SettingsCard>
    </li>
  )
}

export function SkillsSettings() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const listSkills = useSessionStore((s) => s.listSkills)
  const getSkill = useSessionStore((s) => s.getSkill)
  const pickSkillSource = useSessionStore((s) => s.pickSkillSource)
  const installSkill = useSessionStore((s) => s.installSkill)
  const installSkillFromUrl = useSessionStore((s) => s.installSkillFromUrl)
  const searchHubSkills = useSessionStore((s) => s.searchHubSkills)
  const uninstallSkill = useSessionStore((s) => s.uninstallSkill)
  const setSkillEnabled = useSessionStore((s) => s.setSkillEnabled)

  const [skills, setSkills] = useState<readonly SkillSummary[]>([])
  const [detail, setDetail] = useState<{ skill: SkillSummary; data?: SkillDetail } | undefined>()
  const [preview, setPreview] = useState<
    { source: SkillInstallSource; skill: SkillDetail } | undefined
  >()
  const [installing, setInstalling] = useState(false)
  const [uninstalling, setUninstalling] = useState<readonly SkillSummary[]>([])
  const [query, setQuery] = useState('')
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'installed' | 'market'>('installed')
  const [hubQuery, setHubQuery] = useState('')
  const [hubItems, setHubItems] = useState<readonly HubSkillCard[] | undefined>()
  const [hubLoading, setHubLoading] = useState(false)
  const [hubFailed, setHubFailed] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | undefined>()

  const sourceLabel = (skill: SkillSummary) => {
    if (skill.source === 'builtin') return t('skills.source.builtin')
    if (skill.source === 'agents') return t('skills.source.agents')
    if (skill.source === 'user') return t('skills.source.user')
    const name = projectDisplayName(
      projects.find((project) => project.projectId === skill.projectId),
      tc('project.defaultName'),
      skill.projectId ?? '',
    )
    return t('skills.source.project', { name })
  }

  const normalized = query.trim().toLocaleLowerCase()
  const visible =
    normalized === ''
      ? skills
      : skills.filter((skill) =>
          [skill.name, skill.description, sourceLabel(skill)]
            .join(' ')
            .toLocaleLowerCase()
            .includes(normalized),
        )
  const selectedSkills = visible.filter((skill) => selected.includes(keyOf(skill)))
  const selectedRemovable = selectedSkills.filter((skill) => skill.source === 'user')
  const allVisibleSelected =
    visible.length > 0 && visible.every((skill) => selected.includes(keyOf(skill)))

  const load = useCallback(async () => {
    const base = await listSkills()
    if (!base) return
    const enabled = projects.filter((project) => project.enableProjectSkills === true)
    const extras = await Promise.all(enabled.map((project) => listSkills(project.projectId)))
    const merged = [...base]
    const seen = new Set(merged.map(keyOf))
    for (const skill of extras.flatMap((result) => result ?? [])) {
      if (skill.source !== 'project' || seen.has(keyOf(skill))) continue
      seen.add(keyOf(skill))
      merged.push(skill)
    }
    setSkills(merged)
  }, [listSkills, projects])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    void load()
  }, [load])

  const pick = async (kind: PickKind) => {
    const source = await pickSkillSource(kind)
    if (!source) return
    const result = await installSkill(source)
    if (result) setPreview({ source, skill: result.skill })
  }

  const confirmInstall = async () => {
    if (!preview || installing) return
    setInstalling(true)
    const result = await installSkill(preview.source, true)
    setInstalling(false)
    if (result) {
      setPreview(undefined)
      await load()
    }
  }

  const openDetail = async (skill: SkillSummary) => {
    setDetail({ skill })
    const data = await getSkill({
      name: skill.name,
      source: skill.source,
      ...(skill.projectId !== undefined ? { projectId: skill.projectId } : {}),
    })
    setDetail((current) =>
      current !== undefined && keyOf(current.skill) === keyOf(skill)
        ? { skill, ...(data ? { data } : {}) }
        : current,
    )
  }

  const confirmUninstall = async () => {
    if (uninstalling.length === 0) return
    const names = uninstalling.map((skill) => skill.name)
    setUninstalling([])
    await Promise.all(names.map((name) => uninstallSkill(name)))
    await load()
  }

  const applyBatch = async (patch: { enabled?: boolean; pinned?: boolean }) => {
    if (busy || selectedSkills.length === 0) return
    setBusy(true)
    await Promise.all(
      selectedSkills.map((skill) =>
        setSkillEnabled({
          name: skill.name,
          source: skill.source,
          ...(skill.projectId !== undefined ? { projectId: skill.projectId } : {}),
          ...patch,
        }),
      ),
    )
    setBusy(false)
    setSelected([])
    setBatchMode(false)
    await load()
  }

  const toggleBatch = () => {
    setBatchMode(!batchMode)
    setSelected([])
  }

  const searchMarket = async (query = hubQuery) => {
    setHubLoading(true)
    setHubFailed(false)
    const items = await searchHubSkills(query.trim())
    setHubLoading(false)
    if (!items) {
      setHubFailed(true)
      return
    }
    setHubItems(items)
  }

  const installFromMarket = async (card: HubSkillCard) => {
    if (!card.downloadUrl || installingSlug) return
    setInstallingSlug(card.slug)
    const result = await installSkillFromUrl(card.downloadUrl)
    setInstallingSlug(undefined)
    if (result) {
      await load()
      setView('installed')
    }
  }

  useEffect(() => {
    if (view !== 'market' || hubItems !== undefined) return
    let cancelled = false
    setHubLoading(true)
    void searchHubSkills('').then((items) => {
      if (cancelled) return
      setHubLoading(false)
      if (!items) setHubFailed(true)
      else setHubItems(items)
    })
    return () => {
      cancelled = true
    }
  }, [view, hubItems, searchHubSkills])

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SettingsHeader
          icon={<SkillGlyph />}
          title={t('section.skills.title')}
          description={t('section.skills.description')}
        />
        {view === 'installed' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus />
                {t('skills.install')}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void pick('directory')}>
                <FileCode2 />
                {t('skills.install.directory')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void pick('zip')}>
                <FileCode2 />
                {t('skills.install.zip')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div
        role="tablist"
        aria-label={t('section.skills.title')}
        className="flex items-center gap-1 border-b-[0.5px] border-hair pb-2"
      >
        {(
          [
            ['installed', t('skills.tab.installed')],
            ['market', t('skills.tab.market')],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={cn(
              'h-8 rounded-item px-3 text-ui transition-colors',
              view === value
                ? 'bg-raise font-medium text-fg shadow-1'
                : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'market' && (
        <div className="flex flex-col gap-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void searchMarket()
            }}
          >
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">{t('skills.market.search')}</span>
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input
                type="search"
                value={hubQuery}
                onChange={(event) => setHubQuery(event.currentTarget.value)}
                placeholder={t('skills.market.searchPlaceholder')}
                aria-label={t('skills.market.search')}
                className={cn(inputClass, 'pl-8')}
              />
            </label>
            <Button type="submit" disabled={hubLoading}>
              {hubLoading ? <Spinner /> : <Search />}
              {t('skills.market.searchAction')}
            </Button>
          </form>
          <div className="flex items-center gap-2 text-note text-muted">
            <Cloud className="size-3.5" />
            <span>{t('skills.market.hint')}</span>
          </div>
          {hubFailed && (
            <SettingsCard className="items-start">
              <p role="alert" className="text-ui text-danger">
                {t('skills.market.failed')}
              </p>
            </SettingsCard>
          )}
          {hubItems !== undefined && hubItems.length === 0 && !hubLoading && (
            <SettingsCard className="items-start">
              <p className="text-ui text-muted">{t('skills.market.empty')}</p>
            </SettingsCard>
          )}
          {hubItems !== undefined && hubItems.length > 0 && (
            <ul
              aria-label={t('skills.market.list')}
              className="grid grid-cols-1 gap-2 min-[1120px]:grid-cols-2"
            >
              {hubItems.map((card) => (
                <li key={card.slug}>
                  <SettingsCard className="h-full gap-3">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden
                        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[9px] bg-sunk text-fg2"
                      >
                        <SkillGlyph className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui font-medium text-fg">{card.displayName}</p>
                        <p className="truncate text-[11.5px] text-faint">
                          {card.ownerHandle ? `@${card.ownerHandle}` : 'ClawHub'}
                          {card.version ? ` · v${card.version}` : ''}
                        </p>
                      </div>
                    </div>
                    <p className="line-clamp-2 min-h-9 text-note leading-relaxed text-muted">
                      {card.summary || t('skills.market.noSummary')}
                    </p>
                    <div className="mt-auto flex items-center gap-2">
                      <span className="tabular text-[11.5px] text-faint">
                        {t('skills.market.downloads', { count: card.downloads })}
                      </span>
                      <span className="flex-1" />
                      {card.webUrl && (
                        <a
                          href={card.webUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex size-8 items-center justify-center rounded-item text-muted transition-colors hover:bg-hover hover:text-fg"
                          aria-label={t('skills.market.open', { name: card.displayName })}
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                      <Button
                        size="sm"
                        disabled={!card.downloadUrl || installingSlug !== undefined}
                        onClick={() => void installFromMarket(card)}
                      >
                        {installingSlug === card.slug ? <Spinner /> : <Download />}
                        {installingSlug === card.slug
                          ? t('skills.market.installing')
                          : t('skills.market.install')}
                      </Button>
                    </div>
                  </SettingsCard>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view === 'installed' && (
        <>
          {skills.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <ListFilter
                value={query}
                onChange={(value) => {
                  setQuery(value)
                  setSelected([])
                }}
                label={t('skills.search')}
                placeholder={t('skills.searchPlaceholder')}
              />
              <Button
                variant={batchMode ? 'secondary' : 'ghost'}
                aria-pressed={batchMode}
                onClick={toggleBatch}
              >
                <ListChecks />
                {batchMode ? t('skills.batch.exit') : t('skills.batch.toggle')}
              </Button>
            </div>
          )}
          {batchMode && (
            <div className="flex flex-wrap items-center gap-2 rounded-card bg-sunk px-3 py-2">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={selected.length > 0 && !allVisibleSelected}
                aria-label={t('skills.batch.selectAll')}
                onChange={(event) =>
                  setSelected(event.currentTarget.checked ? visible.map(keyOf) : [])
                }
              />
              <span className="text-note text-muted">
                {t('skills.batch.selected', { count: selected.length })}
              </span>
              <span className="flex-1" />
              <Button
                size="sm"
                disabled={selectedSkills.length === 0 || busy}
                onClick={() => void applyBatch({ enabled: true })}
              >
                {t('skills.batch.enable')}
              </Button>
              <Button
                size="sm"
                disabled={selectedSkills.length === 0 || busy}
                onClick={() => void applyBatch({ enabled: false })}
              >
                {t('skills.batch.disable')}
              </Button>
              <Button
                size="sm"
                disabled={selectedSkills.length === 0 || busy}
                onClick={() => void applyBatch({ pinned: true })}
              >
                {t('skills.batch.pin')}
              </Button>
              <Button
                size="sm"
                disabled={selectedSkills.length === 0 || busy}
                onClick={() => void applyBatch({ pinned: false })}
              >
                {t('skills.batch.unpin')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger hover:bg-danger-soft hover:text-danger"
                disabled={selectedRemovable.length === 0 || busy}
                onClick={() => setUninstalling(selectedRemovable)}
              >
                {t('skills.batch.uninstall')}
              </Button>
              {selectedSkills.length > selectedRemovable.length && (
                <p className="w-full text-[11.5px] text-muted">
                  {t('skills.batch.removableHint', {
                    removable: selectedRemovable.length,
                    total: selectedSkills.length,
                  })}
                </p>
              )}
            </div>
          )}
          {skills.length === 0 ? (
            <SettingsEmpty
              icon={<SkillGlyph />}
              title={t('skills.emptyTitle')}
              description={t('skills.empty')}
            />
          ) : visible.length === 0 ? (
            <SettingsCard className="items-center gap-2 py-8 text-center">
              <p className="text-note text-muted">{t('skills.searchEmpty')}</p>
            </SettingsCard>
          ) : (
            <ul aria-label={t('skills.list')} className="flex flex-col gap-3">
              {visible.map((skill) => (
                <SkillCard
                  key={keyOf(skill)}
                  skill={skill}
                  source={sourceLabel(skill)}
                  selectionMode={batchMode}
                  selected={selected.includes(keyOf(skill))}
                  onSelect={(next) =>
                    setSelected((current) =>
                      next
                        ? [...current.filter((key) => key !== keyOf(skill)), keyOf(skill)]
                        : current.filter((key) => key !== keyOf(skill)),
                    )
                  }
                  onChanged={load}
                  onOpen={(item) => void openDetail(item)}
                  onUninstall={(item) => setUninstalling([item])}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <Dialog
        open={detail !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined)
        }}
      >
        {detail && (
          <DialogContent className="w-[min(600px,calc(100vw-32px))]">
            <DialogTitle>{detail.skill.name}</DialogTitle>
            <DialogDescription>
              {t('skills.detail.description', {
                source: sourceLabel(detail.skill),
                sha: detail.skill.sha256.slice(0, 8),
              })}
            </DialogDescription>
            {detail.skill.source === 'user' && (
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:bg-danger-soft hover:text-danger"
                  onClick={() => {
                    setUninstalling([detail.skill])
                    setDetail(undefined)
                  }}
                >
                  <Trash2 />
                  {t('skills.uninstall')}
                </Button>
              </div>
            )}
            <div className="mt-4 max-h-[45vh] overflow-y-auto rounded-card bg-paper px-4 py-3 text-[13.5px] text-fg2 shadow-hair2">
              {detail.data ? (
                <Markdown text={detail.data.body} />
              ) : (
                <p className="text-note text-muted">{t('skills.detail.loading')}</p>
              )}
            </div>
            <h3 className="mt-4 mb-2 text-[13px] font-medium text-fg">{t('skills.files')}</h3>
            <FileList files={detail.data?.files ?? []} truncated={detail.skill.filesTruncated} />
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.close')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={preview !== undefined}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined)
        }}
      >
        {preview && (
          <DialogContent className="w-[min(560px,calc(100vw-32px))]">
            <DialogTitle>
              {t('skills.install.preview.title', { name: preview.skill.name })}
            </DialogTitle>
            <DialogDescription>
              {t('skills.install.preview.description', {
                kind:
                  preview.source.kind === 'directory'
                    ? t('skills.install.directory')
                    : t('skills.install.zip'),
                path: preview.source.path,
              })}
            </DialogDescription>
            <p className="mt-2 text-[13.5px] text-fg2">{preview.skill.description}</p>
            <div className="mt-4 max-h-56 overflow-y-auto rounded-card bg-paper px-4 py-3 text-[13.5px] text-fg2 shadow-hair2">
              <Markdown text={preview.skill.body} />
            </div>
            <p className="mt-3 text-note text-muted">
              {t('skills.install.preview.files', {
                files: preview.skill.files.length,
              })}
            </p>
            <FileList files={preview.skill.files} truncated={preview.skill.filesTruncated} />
            {preview.skill.hasScripts && (
              <p className="mt-3 text-note text-muted">{t('skills.install.preview.scripts')}</p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.cancel')}</Button>
              </DialogClose>
              <Button
                size="lg"
                variant="primary"
                disabled={installing}
                onClick={() => void confirmInstall()}
              >
                {t('skills.install.preview.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={uninstalling.length > 0}
        onOpenChange={(open) => {
          if (!open) setUninstalling([])
        }}
      >
        {uninstalling.length > 0 && (
          <DialogContent tone="danger" icon={<TriangleAlert />}>
            <DialogTitle>
              {uninstalling.length === 1 && uninstalling[0]
                ? t('skills.uninstall.title', { name: uninstalling[0].name })
                : t('skills.batch.uninstallTitle', { count: uninstalling.length })}
            </DialogTitle>
            <DialogDescription>
              {uninstalling.length === 1
                ? t('skills.uninstall.description')
                : t('skills.batch.uninstallDescription')}
            </DialogDescription>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.cancel')}</Button>
              </DialogClose>
              <Button size="lg" variant="danger" onClick={() => void confirmUninstall()}>
                {t('skills.uninstall.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
