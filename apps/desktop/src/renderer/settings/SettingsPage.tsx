/**
 * 设置页框架（M2-09，视觉规范 §8）：与对话页相同的窗口结构。左侧分类导航（顶部“返回对话 Esc”，铺在窗口
 * 底色上），右侧纸面，内容居中、最大宽度 760px。
 *
 * 分类按组列出：通用与外观（M2-09）、模型供应商（M2-10）；权限与审批（M2-11）之后加入，MCP 服务与技能
 * 在 M3。Esc 返回对话（有对话框或菜单打开时不处理）。
 */
import { Cpu, ChevronLeft, PanelLeft, Settings2 } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store-context.js'
import { IconButton, Kbd } from '../ui/index.js'
import { GeneralSettings } from './GeneralSettings.js'
import { ProvidersSettings } from './ProvidersSettings.js'

export type SettingsSection = 'general' | 'providers'

interface SectionEntry {
  readonly id: SettingsSection
  readonly icon: ReactNode
}

/** 分类分组：组名与其中的分类，按显示顺序。 */
const GROUPS: readonly {
  readonly group: 'general' | 'models'
  readonly sections: readonly SectionEntry[]
}[] = [
  { group: 'general', sections: [{ id: 'general', icon: <Settings2 /> }] },
  { group: 'models', sections: [{ id: 'providers', icon: <Cpu /> }] },
]

export function SettingsNav({
  section,
  onSelect,
  onBack,
  onCollapse,
}: {
  readonly section: SettingsSection
  readonly onSelect: (section: SettingsSection) => void
  readonly onBack: () => void
  readonly onCollapse: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: ts } = useTranslation('session')
  const providerCount = useSessionStore((s) => s.settings?.providers.length ?? 0)
  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col">
      <div className="drag flex h-10 shrink-0 items-center justify-end px-2">
        <IconButton
          label={ts('sidebar.collapse')}
          size="icon-sm"
          className="no-drag"
          onClick={onCollapse}
        >
          <PanelLeft />
        </IconButton>
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
      </div>
      <nav aria-label={t('page.nav')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {GROUPS.map(({ group, sections }) => (
          <div key={group} role="group" aria-labelledby={`settings-group-${group}`}>
            <div
              id={`settings-group-${group}`}
              className="px-2.5 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint"
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
                  className={`flex h-8 w-full items-center gap-2.5 rounded-item px-2.5 text-left text-ui transition-colors [&_svg]:size-4 [&_svg]:text-muted ${
                    current ? 'bg-raise font-medium text-fg shadow-1' : 'text-fg2 hover:bg-hover'
                  }`}
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
      </nav>
      <p className="px-4.5 pb-3 text-[11.5px] text-faint">{t('page.local')}</p>
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
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      onBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBack])

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-1.5 pl-3">{leading}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5.5 px-8 pt-4 pb-16">
          {section === 'general' && <GeneralSettings />}
          {section === 'providers' && <ProvidersSettings />}
        </div>
      </div>
    </>
  )
}

/** 设置页的标题与说明。 */
export function SettingsHeader({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}) {
  return (
    <header>
      <h2 className="text-page tracking-[-0.01em] text-fg">{title}</h2>
      <p className="mt-1 text-ui text-muted">{description}</p>
    </header>
  )
}
