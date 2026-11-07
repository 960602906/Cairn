/**
 * 侧栏底部的模型供应商卡片（视觉规范 §2）：已配置的供应商与默认模型；点击打开设置页的“模型供应商”（M2-10）。
 * 没有账户和头像（§10）。
 */
import { ChevronRight, Layers } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'

export function ProviderCard({ onOpen }: { readonly onOpen: () => void }) {
  const { t } = useTranslation('session')
  const settings = useSessionStore((s) => s.settings)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])

  const providers = settings?.providers ?? []
  const current = settings?.defaultModel
  const provider = current && providers.find((p) => p.id === current.providerId)
  const model = provider?.models.find((m) => m.id === current?.modelId)
  const detail =
    providers.length === 0
      ? t('providers.empty')
      : provider && model
        ? t('providers.default', {
            model: `${provider.displayName} · ${model.displayName ?? model.id}`,
          })
        : t('providers.noDefault')

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 rounded-card bg-raise px-3 py-2.5 text-left shadow-1 transition-colors hover:bg-sunk"
    >
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-item bg-sunk2 text-fg2 [&_svg]:size-4">
        <Layers />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-fg">
          {t('providers.title')}
          {providers.length > 0 && (
            <span className="tabular ml-1.5 font-normal text-muted">{providers.length}</span>
          )}
        </span>
        <span className="block truncate text-note text-muted">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-faint" />
    </button>
  )
}
