/**
 * 设置页“技能”（M3-08，capabilities 组）：列出内置、本机 `.agents`、已安装和已开启项目的技能。
 *
 * - 列表按来源分组（内置 / 本机 / 已安装 / 每个项目）；卡片只显示名称、描述与 token，操作只有启用开关和
 *   卸载（用户安装的技能），点卡片打开右侧抽屉看详情。
 *   不再提供“始终加载”：需要时用 `/技能名` 只为这一轮注入正文。旧版留下的始终加载在下一次切换启用时清掉。
 * - 详情是右侧抽屉：顶部固定名称、来源、启用与卸载，正文在自己的区域滚动，附带文件默认收起。
 * - 安装时先用系统对话框选择文件夹或 zip（`skill.pickSource`），主进程只读取并返回预览，确认后才写盘。
 * - 项目内技能只为开启了“启用项目内技能”的项目读取，合并到列表里；内置与已安装的技能只读一次。
 * - 脚本不会自动运行：预览与详情都会标出；是否审批取决于权限设置（默认每次询问）。
 */
import {
  ChevronRight,
  ChevronDown,
  Cloud,
  Download,
  ExternalLink,
  FileCode2,
  ListChecks,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  HubSkillCard,
  SkillDetail,
  SkillFileInfo,
  SkillInstallSource,
  SkillSummary,
} from '@cairn/protocol'
import { CopyButton } from '../CopyButton.js'
import { FileTypeIcon } from '../file-icons.js'
import { Markdown } from '../Markdown.js'
import { projectDisplayName } from '../project-name.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Checkbox,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
  DrawerContent,
  IconButton,
  Spinner,
  Switch,
} from '../ui/index.js'
import { inputClass, SettingsCard, SettingsEmpty } from './Field.js'
import { ListFilter } from './ListFilter.js'
import { SettingsHeader } from './SettingsPage.js'
import { SkillGlyph } from './SettingIcons.js'
import { peekSettingsData, setSettingsData, useSettingsData } from './settings-data-cache.js'

/** 技能页缓存的 key：离开设置再回来先显示上次的列表。 */
const SKILLS_KEY = 'settings:skills'
const HUB_SKILLS_KEY = 'settings:hub:skills'

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
          <li
            key={file.path}
            data-script-file={file.script ? '' : undefined}
            className="flex min-w-0 items-center gap-2 text-[12.5px] text-fg2"
          >
            <FileTypeIcon name={file.path} />
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
  selectionMode = false,
  selected = false,
  onSelect,
  onChanged,
  onOpen,
  onUninstall,
}: {
  readonly skill: SkillSummary
  readonly selectionMode?: boolean
  readonly selected?: boolean
  readonly onSelect?: (selected: boolean) => void
  readonly onChanged: () => Promise<void>
  /** 点卡片打开详情；`element` 用来在抽屉关闭后把焦点还回来。 */
  readonly onOpen: (skill: SkillSummary, element: HTMLElement) => void
  readonly onUninstall: (skill: SkillSummary) => void
}) {
  const { t, i18n } = useTranslation('settings')
  const setSkillEnabled = useSessionStore((s) => s.setSkillEnabled)
  const tokens = new Intl.NumberFormat(i18n.language).format(
    !skill.enabled || skill.shadowed ? 0 : skill.pinned ? skill.tokens.pinned : skill.tokens.index,
  )
  const toggle = (enabled: boolean) => {
    void setSkillEnabled({
      name: skill.name,
      source: skill.source,
      ...(skill.projectId !== undefined ? { projectId: skill.projectId } : {}),
      enabled,
      // 界面已不提供“始终加载”，旧版设过的随这次切换一起清掉
      ...(skill.pinned ? { pinned: false } : {}),
    }).then((updated) => {
      if (updated) void onChanged()
    })
  }
  return (
    <li>
      <SettingsCard
        aria-label={skill.name}
        tabIndex={0}
        className={cn(
          'cursor-pointer gap-2 px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-accent',
          selected && 'shadow-[0_0_0_1.5px_var(--accent)]',
        )}
        onClick={(event) =>
          selectionMode ? onSelect?.(!selected) : onOpen(skill, event.currentTarget)
        }
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (selectionMode) onSelect?.(!selected)
          else onOpen(skill, event.currentTarget)
        }}
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
              <Switch
                checked={skill.enabled}
                aria-label={t('skills.enabledAria', { name: skill.name })}
                title={t('skills.enabled')}
                onCheckedChange={toggle}
              />
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

export function SkillsSettings({
  onOpenPermissions,
}: { readonly onOpenPermissions?: () => void } = {}) {
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

  const {
    value: skillData,
    failed: skillsFailed,
    reload: reloadSkills,
  } = useSettingsData(SKILLS_KEY, async () => {
    // 项目内技能是否读取取决于项目设置，先刷新项目，再一次性合并读取。
    const currentProjects = (await refreshProjects()) ?? projects
    const base = await listSkills()
    if (!base) return undefined
    const enabled = currentProjects.filter((project) => project.enableProjectSkills === true)
    const extras = await Promise.all(enabled.map((project) => listSkills(project.projectId)))
    const merged = [...base]
    const seen = new Set(merged.map(keyOf))
    for (const skill of extras.flatMap((result) => result ?? [])) {
      if (skill.source !== 'project' || seen.has(keyOf(skill))) continue
      seen.add(keyOf(skill))
      merged.push(skill)
    }
    return merged
  })
  const skills = skillData ?? []
  const load = useCallback(async () => {
    await reloadSkills()
  }, [reloadSkills])
  const [detail, setDetail] = useState<{ skill: SkillSummary; data?: SkillDetail } | undefined>()
  /** 打开抽屉的那张卡片，关闭后把焦点还回去。 */
  const detailTrigger = useRef<HTMLElement | undefined>(undefined)
  /** 关闭抽屉是否要把焦点还给卡片（卸载确认、进入批量时不需要）。 */
  const restoreFocus = useRef(false)
  const filesRef = useRef<HTMLDivElement | null>(null)
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
  // 市场列表也缓存：默认浏览结果在离开页面后保留，回来先显示再后台刷新。
  const [hubItems, setHubItems] = useState<readonly HubSkillCard[] | undefined>(() =>
    peekSettingsData(HUB_SKILLS_KEY),
  )
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

  /** 按来源分组：内置 → 本机 → 已安装 → 每个项目；搜索后没有内容的组不显示。 */
  const projectIds: string[] = []
  for (const item of skills) {
    if (
      item.source === 'project' &&
      item.projectId !== undefined &&
      !projectIds.includes(item.projectId)
    ) {
      projectIds.push(item.projectId)
    }
  }
  const visibleKeys = new Set(visible.map(keyOf))
  const groups = [
    {
      key: 'builtin',
      label: t('skills.source.builtin'),
      skills: skills.filter((skill) => skill.source === 'builtin'),
    },
    {
      key: 'agents',
      label: t('skills.source.agents'),
      skills: skills.filter((skill) => skill.source === 'agents'),
    },
    {
      key: 'user',
      label: t('skills.source.user'),
      skills: skills.filter((skill) => skill.source === 'user'),
    },
    ...projectIds.map((projectId) => ({
      key: `project:${projectId}`,
      label: projectDisplayName(
        projects.find((project) => project.projectId === projectId),
        tc('project.defaultName'),
        projectId,
      ),
      skills: skills.filter((skill) => skill.source === 'project' && skill.projectId === projectId),
    })),
  ]
    .map((group) => ({
      ...group,
      skills: group.skills.filter((skill) => visibleKeys.has(keyOf(skill))),
    }))
    .filter((group) => group.skills.length > 0)

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

  const [filesOpen, setFilesOpen] = useState(false)

  const openDetail = async (skill: SkillSummary, element?: HTMLElement) => {
    if (element !== undefined) detailTrigger.current = element
    restoreFocus.current = true
    setFilesOpen(false)
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

  /** 关闭抽屉；`restore` 为 false 时（卸载确认、进入批量）不把焦点还给卡片。 */
  const closeDetail = (restore = true) => {
    restoreFocus.current = restore
    setDetail(undefined)
  }

  /** 详情抽屉里的启用开关：与卡片相同，顺带清掉旧版的“始终加载”。 */
  const toggleDetail = async (enabled: boolean) => {
    if (detail === undefined) return
    const skill = detail.skill
    const updated = await setSkillEnabled({
      name: skill.name,
      source: skill.source,
      ...(skill.projectId !== undefined ? { projectId: skill.projectId } : {}),
      enabled,
      ...(skill.pinned ? { pinned: false } : {}),
    })
    if (!updated) return
    setDetail((current) =>
      current !== undefined && keyOf(current.skill) === keyOf(skill)
        ? { ...current, skill: { ...current.skill, enabled, pinned: false } }
        : current,
    )
    await load()
  }

  /** 列表刷新后把抽屉里的启用/覆盖状态同步过来（例如刚启用就变成被覆盖）。 */
  useEffect(() => {
    setDetail((current) => {
      if (current === undefined) return current
      const fresh = skills.find((skill) => keyOf(skill) === keyOf(current.skill))
      if (
        fresh === undefined ||
        (fresh.enabled === current.skill.enabled &&
          fresh.shadowed === current.skill.shadowed &&
          fresh.pinned === current.skill.pinned)
      ) {
        return current
      }
      return {
        ...current,
        skill: {
          ...current.skill,
          enabled: fresh.enabled,
          shadowed: fresh.shadowed,
          pinned: fresh.pinned,
        },
      }
    })
  }, [skills])

  /** 点脚本提示条：展开附带文件并滚到第一个脚本。 */
  const expandScripts = () => {
    setFilesOpen(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        filesRef.current
          ?.querySelector<HTMLElement>('[data-script-file]')
          ?.scrollIntoView?.({ block: 'nearest' })
      })
    })
  }

  const detailSkill = detail?.skill
  const scriptFiles = detail?.data?.files.filter((file) => file.script) ?? []
  /** 被覆盖时胜出的那份：同名、已启用、没有被覆盖。 */
  const shadowWinner =
    detailSkill?.shadowed === true
      ? skills.find((skill) => skill.name === detailSkill.name && skill.enabled && !skill.shadowed)
      : undefined
  const usage =
    detailSkill === undefined
      ? undefined
      : detailSkill.shadowed
        ? shadowWinner !== undefined
          ? t('skills.usage.shadowed', {
              name: detailSkill.name,
              winner: sourceLabel(shadowWinner),
            })
          : t('skills.usage.shadowedFallback', { name: detailSkill.name })
        : detailSkill.enabled
          ? t('skills.usage.enabled', { name: detailSkill.name })
          : t('skills.usage.disabled', { name: detailSkill.name })

  const confirmUninstall = async () => {
    if (uninstalling.length === 0) return
    const names = uninstalling.map((skill) => skill.name)
    setUninstalling([])
    await Promise.all(names.map((name) => uninstallSkill(name)))
    await load()
  }

  const applyBatch = async (patch: { enabled: boolean }) => {
    if (busy || selectedSkills.length === 0) return
    setBusy(true)
    await Promise.all(
      selectedSkills.map((skill) =>
        setSkillEnabled({
          name: skill.name,
          source: skill.source,
          ...(skill.projectId !== undefined ? { projectId: skill.projectId } : {}),
          ...patch,
          ...(skill.pinned ? { pinned: false } : {}),
        }),
      ),
    )
    setBusy(false)
    setSelected([])
    setBatchMode(false)
    await load()
  }

  const toggleBatch = () => {
    if (!batchMode) closeDetail(false)
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

  // 进入市场时先显示缓存里的浏览结果，同时后台刷新；用户正在搜索时不覆盖搜索结果。
  const hubQueryRef = useRef(hubQuery)
  hubQueryRef.current = hubQuery
  useEffect(() => {
    if (view !== 'market') return
    let cancelled = false
    setHubLoading(true)
    void searchHubSkills('').then((items) => {
      if (cancelled) return
      setHubLoading(false)
      if (!items) {
        setHubFailed(true)
        return
      }
      setHubFailed(false)
      setSettingsData(HUB_SKILLS_KEY, items)
      if (hubQueryRef.current.trim() === '') setHubItems(items)
    })
    return () => {
      cancelled = true
    }
  }, [view, searchHubSkills])

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
          {skillData === undefined && !skillsFailed ? (
            <div className="flex items-center justify-center py-10 text-muted">
              <Spinner className="size-4" />
            </div>
          ) : skills.length === 0 ? (
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
            <div className="flex flex-col gap-6">
              {groups.map((group) => (
                <section
                  key={group.key}
                  aria-labelledby={`skills-group-${group.key}`}
                  className="flex flex-col gap-2.5"
                >
                  <h3
                    id={`skills-group-${group.key}`}
                    className="flex items-center gap-2 text-[12.5px] font-medium text-muted"
                  >
                    <span>{group.label}</span>
                    <span className="tabular text-[11.5px] font-normal text-faint">
                      {group.skills.length}
                    </span>
                  </h3>
                  <ul className="flex flex-col gap-3">
                    {group.skills.map((skill) => (
                      <SkillCard
                        key={keyOf(skill)}
                        skill={skill}
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
                        onOpen={(item, element) => void openDetail(item, element)}
                        onUninstall={(item) => setUninstalling([item])}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog
        open={detail !== undefined}
        modal={false}
        onOpenChange={(open) => {
          if (!open) closeDetail()
        }}
      >
        {detail && (
          // 右侧抽屉：标题行固定，正文在自己的区域滚动；不锁滚动、不加遮罩，左侧列表仍可点击。
          <DrawerContent
            aria-label={t('skills.drawerAria', { name: detail.skill.name })}
            onPointerDownOutside={(event) => event.preventDefault()}
            onFocusOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (!restoreFocus.current) return
              const target = detailTrigger.current
              if (target !== undefined && target.isConnected) target.focus()
            }}
          >
            <div className="flex shrink-0 items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate">{detail.skill.name}</DialogTitle>
                <DialogDescription>
                  {t('skills.detail.description', {
                    source: sourceLabel(detail.skill),
                    sha: detail.skill.sha256.slice(0, 8),
                  })}
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 pt-1">
                <Switch
                  checked={detail.skill.enabled}
                  aria-label={t('skills.enabledAria', { name: detail.skill.name })}
                  title={t('skills.enabled')}
                  onCheckedChange={(enabled) => void toggleDetail(enabled)}
                />
                {detail.skill.source === 'user' && (
                  <IconButton
                    label={t('skills.uninstallAria', { name: detail.skill.name })}
                    size="icon-sm"
                    className="hover:bg-danger-soft hover:text-danger"
                    onClick={() => {
                      setUninstalling([detail.skill])
                      closeDetail(false)
                    }}
                  >
                    <Trash2 />
                  </IconButton>
                )}
                <DialogClose asChild>
                  <IconButton label={tc('action.close')} size="icon-sm">
                    <X />
                  </IconButton>
                </DialogClose>
              </div>
            </div>

            {scriptFiles.length > 0 && (
              <div className="mt-4 flex shrink-0 items-start gap-2 rounded-card bg-warn-soft px-3 py-2 text-warn">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={expandScripts}
                    className="block w-full cursor-pointer text-left text-note leading-relaxed outline-none hover:opacity-90 focus-visible:ring-1 focus-visible:ring-warn"
                  >
                    {t(
                      scriptFiles.length === 1
                        ? 'skills.scripts.hintOne'
                        : 'skills.scripts.hintOther',
                      { n: scriptFiles.length },
                    )}
                  </button>
                  {onOpenPermissions !== undefined && (
                    <button
                      type="button"
                      onClick={onOpenPermissions}
                      className="mt-1 cursor-pointer text-note font-medium underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-warn"
                    >
                      {t('skills.scripts.permissions')}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 flex shrink-0 items-start gap-1.5" data-skill-usage>
              <p className="min-w-0 flex-1 text-note leading-relaxed text-fg2">{usage}</p>
              {detailSkill !== undefined && detailSkill.enabled && !detailSkill.shadowed && (
                <CopyButton
                  text={`/${detailSkill.name} `}
                  className="ml-0.5 text-muted hover:bg-hover hover:text-fg"
                />
              )}
            </div>

            <div
              data-skill-body
              className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-card bg-paper px-4 py-3 text-[13.5px] text-fg2 shadow-hair2"
            >
              {detail.data ? (
                <Markdown text={detail.data.body} />
              ) : (
                <p className="text-note text-muted">{t('skills.detail.loading')}</p>
              )}
            </div>
            {detail.data && (
              <Collapsible open={filesOpen} onOpenChange={setFilesOpen} className="mt-3 shrink-0">
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-item py-1 text-left text-[13px] font-medium text-fg outline-none hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent">
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'size-3.5 shrink-0 text-faint transition-transform',
                      filesOpen && 'rotate-90',
                    )}
                  />
                  {t('skills.files')}
                  <span className="tabular text-[12px] font-normal text-faint">
                    {detail.data.files.length}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div ref={filesRef} className="mt-1.5 max-h-40 overflow-y-auto pr-1">
                    <FileList files={detail.data.files} truncated={detail.skill.filesTruncated} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </DrawerContent>
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
