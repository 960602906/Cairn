/**
 * 设置页框架（M2-09，视觉规范 §8）：与对话页相同的窗口结构。左侧分类导航（顶部“返回对话 Esc”，铺在窗口
 * 底色上），右侧纸面，内容居中、最大宽度 920px；窄窗口收窄内边距。
 *
 * 分类收敛为三组：常规（通用与外观、更新、关于）、模型与能力（模型供应商、技能、MCP 服务）
 * 与安全（权限与审批）。项目操作在会话栏里，不再占用设置分类。
 * Esc 返回对话（有对话框或菜单打开时不处理）。
 */
import {
  ChevronLeft,
  Cpu,
  Info,
  Palette,
  PanelLeftClose,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store-context.js'
import { CairnMark, IconButton, Kbd } from '../ui/index.js'
import { GeneralSettings } from './GeneralSettings.js'
import { AboutSettings } from './AboutSettings.js'
import { McpSettings } from './McpSettings.js'
import { PermissionsSettings } from './PermissionsSettings.js'
import { ProvidersSettings } from './ProvidersSettings.js'
import { McpGlyph, SkillGlyph } from './SettingIcons.js'
import { SkillsSettings } from './SkillsSettings.js'
import { UpdateSettings } from './UpdateSettings.js'
import { TITLE_BAR_INSET } from '../layout/WindowControls.js'

export type SettingsSection =
  'general' | 'update' | 'providers' | 'skills' | 'mcp' | 'permissions' | 'about'

interface SectionEntry {
  readonly id: SettingsSection
  readonly icon: ReactNode
}

/** 分类分组：组名与其中的分类，按显示顺序。 */
const GROUPS: readonly {
  readonly group: 'general' | 'modelCapabilities' | 'security'
  readonly sections: readonly SectionEntry[]
}[] = [
  {
    group: 'general',
    sections: [
      { id: 'general', icon: <Palette /> },
      { id: 'update', icon: <RefreshCw /> },
      { id: 'about', icon: <Info /> },
    ],
  },
  {
    group: 'modelCapabilities',
    sections: [
      { id: 'providers', icon: <Cpu /> },
      { id: 'skills', icon: <SkillGlyph /> },
      { id: 'mcp', icon: <McpGlyph /> },
    ],
  },
  { group: 'security', sections: [{ id: 'permissions', icon: <ShieldCheck /> }] },
]

export function SettingsNav({
  open = true,
  collapsible = true,
  section,
  onSelect,
  onBack,
  onCollapse,
}: {
  readonly open?: boolean
  /** 叠层布局里导航常驻，不再显示收起按钮。 */
  readonly collapsible?: boolean
  readonly section: SettingsSection
  readonly onSelect: (section: SettingsSection) => void
  readonly onBack: () => void
  readonly onCollapse: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: ts } = useTranslation('session')
  const { t: tc } = useTranslation()
  const providerCount = useSessionStore((s) => s.settings?.providers.length ?? 0)
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const matches = (id: SettingsSection) =>
    [t(`section.${id}.title`), t(`section.${id}.description`), t(`page.keywords.${id}`)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalized)
  const visibleGroups = GROUPS.map(({ group, sections }) => ({
    group,
    sections: normalized === '' ? sections : sections.filter(({ id }) => matches(id)),
  })).filter(({ sections }) => sections.length > 0)
  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      className={`h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'w-[252px] opacity-100' : 'pointer-events-none w-0 opacity-0'
      }`}
    >
      <div
        className={`flex h-full w-[252px] flex-col transition-transform duration-200 ease-out motion-reduce:transition-none ${
          open ? 'translate-x-0' : '-translate-x-3'
        }`}
      >
        {collapsible ? (
          <div className="drag flex h-10 shrink-0 items-center justify-end px-2">
            <IconButton
              label={ts('sidebar.collapse')}
              size="icon-sm"
              className="no-drag"
              onClick={onCollapse}
            >
              <PanelLeftClose />
            </IconButton>
          </div>
        ) : (
          <div className="drag h-3 shrink-0" />
        )}
        <div className="drag flex h-9 shrink-0 items-center gap-2 px-2.5 pb-1">
          <CairnMark size={22} className="text-fg" />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">
            {tc('app.name')}
          </span>
        </div>
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-full items-center gap-2 rounded-item px-2.5 text-ui text-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4"
          >
            <ChevronLeft />
            <span className="flex-1 text-left">{t('page.back')}</span>
            <Kbd aria-hidden>{t('page.backKey')}</Kbd>
          </button>
          <label className="relative mt-2 block">
            <span className="sr-only">{t('page.search')}</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('page.search')}
              aria-label={t('page.search')}
              className="h-8 w-full rounded-item bg-sunk/60 pr-2.5 pl-8 text-[12.5px] text-fg shadow-hair outline-none transition-colors placeholder:text-faint hover:bg-sunk focus:bg-paper focus:shadow-[inset_0_0_0_0.5px_var(--hair2),0_0_0_3px_var(--accent-soft)]"
            />
          </label>
        </div>
        <nav aria-label={t('page.nav')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {visibleGroups.map(({ group, sections }) => (
            <div key={group} role="group" aria-labelledby={`settings-group-${group}`}>
              <div
                id={`settings-group-${group}`}
                className="px-2.5 pt-3.5 pb-1.5 text-[11.5px] font-medium text-muted"
              >
                {t(`group.${group}`)}
              </div>
              {sections.map(({ id, icon }) => {
                const current = id === section
                return (
                  <button
                    key={id}
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => onSelect(id)}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-item px-2.5 text-left text-ui transition-colors [&_svg]:size-4 [&_svg]:text-muted ${
                      current ? 'bg-raise font-medium text-fg shadow-1' : 'text-fg2 hover:bg-hover'
                    } ${current ? '[&_svg]:text-accent' : ''}`}
                  >
                    {icon}
                    <span className="flex-1">{t(`section.${id}.title`)}</span>
                    {id === 'providers' && providerCount > 0 && (
                      <span className="tabular text-[11.5px] font-normal text-faint">
                        {providerCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <p className="px-2.5 py-6 text-center text-note text-muted">
              {t('page.searchNoResults')}
            </p>
          )}
        </nav>
        <p className="px-4.5 pb-3 text-[11.5px] text-muted">{t('page.local')}</p>
      </div>
    </aside>
  )
}

/** 设置页的纸面内容；`leading` 放在顶栏（侧栏收起时的展开按钮）。 */
export function SettingsContent({
  section,
  leading,
  onBack,
}: {
  readonly section: SettingsSection
  readonly leading?: ReactNode
  readonly onBack: () => void
}) {
  // Esc 返回对话；对话框或菜单打开时交给它们
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
        )
      )
        return
      event.preventDefault()
      onBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBack])

  return (
    <>
      <div
        className="drag flex h-12 shrink-0 items-center gap-1.5 bg-chrome pl-3"
        style={TITLE_BAR_INSET}
      >
        {leading}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[920px] flex-col gap-6 px-8 pt-6 pb-16 max-[640px]:px-4">
          {section === 'general' && <GeneralSettings />}
          {section === 'update' && <UpdateSettings />}
          {section === 'providers' && <ProvidersSettings />}
          {section === 'skills' && <SkillsSettings />}
          {section === 'mcp' && <McpSettings />}
          {section === 'permissions' && <PermissionsSettings />}
          {section === 'about' && <AboutSettings />}
        </div>
      </div>
    </>
  )
}

/** 设置页的标题与说明。 */
export function SettingsHeader({
  icon,
  title,
  description,
}: {
  readonly icon?: ReactNode
  readonly title: string
  readonly description: string
}) {
  return (
    <header className="flex items-start gap-4 pt-1">
      {icon && (
        <span
          aria-hidden
          className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-[12px] bg-accent-soft text-accent shadow-hair [&_svg]:size-5"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="text-page tracking-[-0.01em] text-fg">{title}</h2>
        <p className="mt-1 max-w-[62ch] text-ui leading-relaxed text-muted">{description}</p>
      </div>
    </header>
  )
}
