/**
 * 生效配置预览（M3-12，管理界面 §4.3）：`agent.effectiveConfig` 返回的合并系统提示词、最终工具与
 * Skills、权限规则，以及上下文预算条形图。回答“这个 Agent 实际运行时会是什么样”。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentEffectiveConfig as EffectiveConfig } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'

const BAR_COLORS = ['bg-accent', 'bg-ok', 'bg-warn', 'bg-danger', 'bg-muted'] as const

export function AgentEffectiveConfig({
  agentId,
  sessionId,
}: {
  readonly agentId: string
  readonly sessionId?: string
}) {
  const { t } = useTranslation('agents')
  const agentEffectiveConfig = useSessionStore((s) => s.agentEffectiveConfig)
  const [config, setConfig] = useState<EffectiveConfig | undefined>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void agentEffectiveConfig(agentId, sessionId).then((result) => {
      if (cancelled) return
      if (result) setConfig(result)
      else setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [agentEffectiveConfig, agentId, sessionId])

  if (failed) return <p className="text-note text-danger">{t('effective.loadFailed')}</p>
  if (!config) return null

  const budget = config.budget
  const used =
    budget.systemPromptTokens +
    budget.toolsTokens +
    budget.skillsTokens +
    budget.historyTokens +
    budget.reserveOutputTokens
  const free = Math.max(0, budget.contextWindow - used)
  const total = Math.max(budget.contextWindow, used, 1)
  const parts = [
    { key: 'effective.budget.system', value: budget.systemPromptTokens },
    { key: 'effective.budget.tools', value: budget.toolsTokens },
    { key: 'effective.budget.skills', value: budget.skillsTokens },
    { key: 'effective.budget.history', value: budget.historyTokens },
    { key: 'effective.budget.reserve', value: budget.reserveOutputTokens },
  ].filter((part) => part.value > 0)

  return (
    <section className="flex flex-col gap-6">
      <header className="flex items-center gap-2">
        <h3 className="text-heading text-fg">{t('effective.title')}</h3>
        <span className="rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
          {config.source === 'draft'
            ? t('effective.source.draft')
            : t('effective.source.published', { version: config.version })}
        </span>
      </header>

      <div>
        <h4 className="mb-2 text-note font-medium text-fg2">{t('effective.budget')}</h4>
        <div
          role="img"
          aria-label={t('effective.budget')}
          className="flex h-3 w-full overflow-hidden rounded-full bg-sunk"
        >
          {parts.map((part, index) => (
            <span
              key={part.key}
              title={`${t(part.key)}: ${part.value}`}
              style={{ width: `${(part.value / total) * 100}%` }}
              className={BAR_COLORS[index % BAR_COLORS.length]}
            />
          ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-note text-muted">
          {parts.map((part, index) => (
            <li key={part.key} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-sm ${BAR_COLORS[index % BAR_COLORS.length]}`} />
              <span>
                {t(part.key)}: <span className="tabular">{part.value.toLocaleString()}</span>
              </span>
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-sunk2" />
            <span>
              {t('effective.budget.free')}: <span className="tabular">{free.toLocaleString()}</span>
            </span>
          </li>
        </ul>
      </div>

      <div>
        <h4 className="mb-2 text-note font-medium text-fg2">{t('effective.prompt')}</h4>
        <pre className="max-h-[320px] overflow-auto rounded-card bg-code-bg p-3 font-mono text-[12px] leading-[20px] whitespace-pre-wrap text-fg2 shadow-hair2">
          {config.systemPrompt}
        </pre>
      </div>

      <div>
        <h4 className="mb-2 text-note font-medium text-fg2">{t('effective.tools')}</h4>
        {config.tools.length === 0 ? (
          <p className="text-note text-muted">{t('effective.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {config.tools.map((tool) => (
              <li key={tool.name} className="text-[12.5px] text-fg2">
                <code className="font-mono">{tool.name}</code>
                <span className="ml-2 text-note text-faint">{tool.category}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-note font-medium text-fg2">{t('effective.skills')}</h4>
        {config.skills.length === 0 ? (
          <p className="text-note text-muted">{t('effective.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {config.skills.map((skill) => (
              <li key={skill.name} className="text-[12.5px] text-fg2">
                <code className="font-mono">{skill.name}</code>
                <span className="tabular ml-2 text-note text-faint">
                  {skill.tokens.index + skill.tokens.pinned}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-note font-medium text-fg2">{t('effective.permissions')}</h4>
        <ul className="flex flex-col gap-1">
          {config.permissionRules.map((rule, index) => (
            <li key={index} className="text-[12.5px] text-fg2">
              <span
                className={
                  rule.effect === 'allow'
                    ? 'text-ok'
                    : rule.effect === 'deny'
                      ? 'text-danger'
                      : 'text-warn'
                }
              >
                {rule.effect}
              </span>
              <span className="ml-2 font-mono">{JSON.stringify(rule.match)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
