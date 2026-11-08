/**
 * 版本历史与对比（M3-12，管理界面 §5.2）：发布版本列表、草稿、结构化字段表格对比、指令文本 diff，
 * 旧版本可以恢复为草稿（覆盖当前草稿，不改写历史）。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentDetail,
  AgentDiff,
  AgentDiffEndpoint,
  AgentVersionSummary,
} from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { Button, cn } from '../ui/index.js'
import { diffRows } from '../diff-model.js'

const show = (value: unknown): string => {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 0)
}

export function AgentVersions({
  agentId,
  onRestore,
}: {
  readonly agentId: string
  readonly onRestore: (detail: AgentDetail) => void | Promise<void>
}) {
  const { t, i18n } = useTranslation('agents')
  const agentVersions = useSessionStore((s) => s.agentVersions)
  const agentDiff = useSessionStore((s) => s.agentDiff)
  const getAgent = useSessionStore((s) => s.getAgent)
  const saveAgentDraft = useSessionStore((s) => s.saveAgentDraft)
  const [versions, setVersions] = useState<readonly AgentVersionSummary[]>([])
  const [from, setFrom] = useState<AgentDiffEndpoint>('draft')
  const [to, setTo] = useState<AgentDiffEndpoint>('draft')
  const [diff, setDiff] = useState<AgentDiff | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void agentVersions(agentId).then((list) => {
      if (cancelled) return
      const loaded = list ?? []
      setVersions(loaded)
      const latest = loaded.at(-1)?.version
      if (latest !== undefined) {
        setFrom(latest)
        setTo('draft')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [agentId, agentVersions])

  useEffect(() => {
    let cancelled = false
    void agentDiff(agentId, from, to).then((result) => {
      if (!cancelled) setDiff(result)
    })
    return () => {
      cancelled = true
    }
  }, [agentId, agentDiff, from, to])

  const restore = async (version: number) => {
    const detail = await getAgent(agentId, version)
    if (!detail?.published) return
    const next = await saveAgentDraft({
      id: agentId,
      name: detail.published.name,
      description: detail.published.description,
      ...(detail.published.icon ? { icon: detail.published.icon } : {}),
      ...(detail.published.color ? { color: detail.published.color } : {}),
      instructions: detail.published.instructions,
      model: detail.published.model,
      tools: detail.published.tools,
      skills: detail.published.skills,
      permissions: detail.published.permissions,
      limits: detail.published.limits,
      context: detail.published.context,
      memory: detail.published.memory,
      ...(detail.published.tags ? { tags: detail.published.tags } : {}),
      ...(detail.published.inputSchema ? { inputSchema: detail.published.inputSchema } : {}),
      ...(detail.published.outputSchema ? { outputSchema: detail.published.outputSchema } : {}),
    })
    if (next) await onRestore(next)
  }

  const rows =
    diff?.instructions?.from && diff?.instructions?.to
      ? diffRows(diff.instructions.from.split(/\r?\n/), diff.instructions.to.split(/\r?\n/))
      : []

  return (
    <section className="flex flex-col gap-5">
      <h3 className="text-heading text-fg">{t('versions.title')}</h3>
      {loading ? null : versions.length === 0 ? (
        <p className="text-note text-muted">{t('versions.empty')}</p>
      ) : (
        <ul aria-label={t('versions.title')} className="flex flex-col gap-1.5">
          <li className="flex items-center gap-3 rounded-card bg-raise px-3.5 py-2.5 shadow-hair2">
            <span className="text-ui font-medium text-fg">{t('versions.draft')}</span>
            <span className="ml-auto">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFrom(to)
                  setTo('draft')
                }}
              >
                {t('versions.compare')}
              </Button>
            </span>
          </li>
          {[...versions].reverse().map((version) => (
            <li
              key={version.version}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-card px-3.5 py-2.5 shadow-hair2',
                version.version === versions.at(-1)?.version ? 'bg-raise' : 'bg-paper',
              )}
            >
              <span className="tabular text-ui font-medium text-fg">
                {t('version', { version: version.version })}
              </span>
              {version.version === versions.at(-1)?.version && (
                <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">
                  {t('versions.current')}
                </span>
              )}
              <span className="text-note text-muted">
                {t('versions.publishedAt', {
                  date: new Date(version.publishedAt || 0).toLocaleString(i18n.language),
                })}
              </span>
              <span className="text-note text-faint">
                {t('versions.usedBy', { count: version.usedBySessions })}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFrom(version.version)
                    setTo('draft')
                  }}
                >
                  {t('versions.compare')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void restore(version.version)}>
                  {t('versions.restore')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-note text-muted">
          {t('versions.from')}
          <select
            aria-label={t('versions.from')}
            className="h-8 rounded-item bg-raise px-2 text-[12.5px] text-fg shadow-hair2"
            value={String(from)}
            onChange={(e) => setFrom(e.target.value === 'draft' ? 'draft' : Number(e.target.value))}
          >
            <option value="draft">{t('versions.draft')}</option>
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                {t('version', { version: version.version })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-note text-muted">
          {t('versions.to')}
          <select
            aria-label={t('versions.to')}
            className="h-8 rounded-item bg-raise px-2 text-[12.5px] text-fg shadow-hair2"
            value={String(to)}
            onChange={(e) => setTo(e.target.value === 'draft' ? 'draft' : Number(e.target.value))}
          >
            <option value="draft">{t('versions.draft')}</option>
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                {t('version', { version: version.version })}
              </option>
            ))}
          </select>
        </label>
      </div>

      {diff && diff.fields.length === 0 && diff.instructions.from === diff.instructions.to ? (
        <p className="text-note text-muted">{t('versions.noDiff')}</p>
      ) : null}
      {diff && diff.fields.length > 0 && (
        <div>
          <h4 className="mb-2 text-note font-medium text-fg2">{t('versions.fields')}</h4>
          <table className="w-full table-fixed border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-note text-muted">
                <th className="w-1/4 py-1.5 font-normal"> </th>
                <th className="py-1.5 font-normal">{t('versions.from')}</th>
                <th className="py-1.5 font-normal">{t('versions.to')}</th>
              </tr>
            </thead>
            <tbody>
              {diff.fields.map((field) => (
                <tr key={field.path} className="border-t-[0.5px] border-hair align-top">
                  <td className="py-1.5 pr-2 text-fg2">
                    {t(`field.${field.path}`, { defaultValue: field.path })}
                  </td>
                  <td className="py-1.5 pr-2 break-words text-danger">{show(field.from)}</td>
                  <td className="py-1.5 break-words text-ok">{show(field.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diff && diff.instructions.from !== diff.instructions.to && (
        <div>
          <h4 className="mb-2 text-note font-medium text-fg2">{t('versions.instructions')}</h4>
          <pre className="overflow-x-auto rounded-card bg-code-bg p-3 font-mono text-[12px] leading-[20px] shadow-hair2">
            {rows.map((row, index) => (
              <div
                key={index}
                data-type={row.type}
                className={cn(
                  'whitespace-pre-wrap',
                  row.type === 'add' && 'bg-add-bg text-add-fg',
                  row.type === 'del' && 'bg-del-bg text-del-fg',
                )}
              >
                {row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}
                {row.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </section>
  )
}
