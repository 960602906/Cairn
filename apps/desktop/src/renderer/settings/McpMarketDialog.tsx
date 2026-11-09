/** MCP 市场（M5）：从官方 MCP Registry 搜索可远程接入的服务，一键写入配置。 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, Download, ExternalLink, RefreshCw, Search } from 'lucide-react'
import type { HubMcpCard } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Spinner,
} from '../ui/index.js'
import { inputClass, SettingsCard } from './Field.js'

export function McpMarketDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onInstalled: (serverId: string) => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const searchHubMcp = useSessionStore((s) => s.searchHubMcp)
  const addMcpServer = useSessionStore((s) => s.addMcpServer)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<readonly HubMcpCard[] | undefined>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState<string | undefined>()

  const search = async (next = query) => {
    setLoading(true)
    setFailed(false)
    const result = await searchHubMcp(next.trim())
    setLoading(false)
    if (!result) {
      setFailed(true)
      return
    }
    setItems(result)
  }

  useEffect(() => {
    if (!open || items !== undefined) return
    let cancelled = false
    setLoading(true)
    void searchHubMcp('').then((result) => {
      if (cancelled) return
      setLoading(false)
      if (!result) setFailed(true)
      else setItems(result)
    })
    return () => {
      cancelled = true
    }
  }, [open, items, searchHubMcp])

  const install = async (card: HubMcpCard) => {
    if (!card.url || card.requiresAuth || adding) return
    setAdding(card.id)
    const result = await addMcpServer({
      name: card.title,
      kind: 'http',
      url: card.url,
      enabled: true,
    })
    setAdding(undefined)
    if (!result) return
    onInstalled(result.serverId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-64px)] w-[min(780px,calc(100vw-32px))] flex-col">
        <DialogTitle className="flex items-center gap-2">
          <Cloud className="size-4 text-accent" />
          {t('mcp.market.title')}
        </DialogTitle>
        <DialogDescription>{t('mcp.market.description')}</DialogDescription>
        <form
          className="mt-4 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{t('mcp.market.search')}</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('mcp.market.searchPlaceholder')}
              aria-label={t('mcp.market.search')}
              className={cn(inputClass, 'pl-8')}
            />
          </label>
          <Button type="submit" disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw />}
            {t('mcp.market.searchAction')}
          </Button>
        </form>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {failed && (
            <p role="alert" className="py-6 text-center text-ui text-danger">
              {t('mcp.market.failed')}
            </p>
          )}
          {items !== undefined && items.length === 0 && !loading && (
            <p className="py-8 text-center text-ui text-muted">{t('mcp.market.empty')}</p>
          )}
          <ul className="grid grid-cols-1 gap-2 min-[720px]:grid-cols-2">
            {items?.map((card) => {
              const installable = card.transport === 'http' && card.url && !card.requiresAuth
              const link = card.homepage ?? card.repository
              return (
                <li key={card.id}>
                  <SettingsCard className="h-full gap-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui font-medium text-fg">{card.title}</p>
                        <p className="truncate font-mono text-[11px] text-faint">{card.name}</p>
                      </div>
                      <span className="rounded-full bg-sunk px-1.5 py-0.5 text-[10.5px] text-muted">
                        {card.transport === 'http' ? 'HTTP' : 'stdio'}
                      </span>
                    </div>
                    <p className="line-clamp-2 min-h-9 text-note leading-relaxed text-muted">
                      {card.description || t('mcp.market.noDescription')}
                    </p>
                    <div className="mt-auto flex items-center gap-1.5">
                      {card.requiresAuth && (
                        <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-[10.5px] text-warn">
                          {t('mcp.market.authRequired')}
                        </span>
                      )}
                      <span className="flex-1" />
                      {link && (
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={t('mcp.market.open', { name: card.title })}
                          className="inline-flex size-8 items-center justify-center rounded-item text-muted transition-colors hover:bg-hover hover:text-fg"
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                      <Button
                        size="sm"
                        disabled={!installable || adding !== undefined}
                        onClick={() => void install(card)}
                      >
                        {adding === card.id ? <Spinner /> : <Download />}
                        {adding === card.id ? t('mcp.market.adding') : t('mcp.market.install')}
                      </Button>
                    </div>
                  </SettingsCard>
                </li>
              )
            })}
          </ul>
        </div>
        <DialogFooter>
          <Button size="lg" onClick={() => onOpenChange(false)}>
            {tc('action.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
