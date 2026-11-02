/**
 * 开发模式的事件查看器（M0-15d，架构 §20）：按到达顺序列出当前会话收到的原始事件（补发与实时推送），
 * 展开一条可查看完整内容。增量事件数量多，默认隐藏。事件来自 store 的 `eventLog`，只在开发模式开启。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isPersistedEvent, type EventEnvelope } from '@nexus/protocol'
import { useSessionStore } from './store-context.js'

const NO_EVENTS: readonly EventEnvelope[] = []

function EventRow({ event }: { readonly event: EventEnvelope }) {
  const { i18n } = useTranslation()
  const time = new Date(event.ts).toLocaleTimeString(i18n.language, { hour12: false })
  return (
    <li>
      <details>
        <summary>
          <code>{`#${event.seq} ${event.type}`}</code> <time>{time}</time>
        </summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
    </li>
  )
}

export function EventViewer() {
  const { t } = useTranslation()
  const events = useSessionStore((s) =>
    s.activeSessionId === undefined ? NO_EVENTS : (s.eventLog[s.activeSessionId] ?? NO_EVENTS),
  )
  const [showDeltas, setShowDeltas] = useState(false)
  const shown = showDeltas ? events : events.filter(isPersistedEvent)
  return (
    <details>
      <summary>{t('dev.events.title')}</summary>
      <label>
        <input
          type="checkbox"
          checked={showDeltas}
          onChange={(e) => setShowDeltas(e.target.checked)}
        />
        {t('dev.events.showDeltas')}
      </label>
      <p>{t('dev.events.count', { count: shown.length })}</p>
      {shown.length > 0 && (
        <ol aria-label={t('dev.events.title')}>
          {shown.map((event, index) => (
            <EventRow key={index} event={event} />
          ))}
        </ol>
      )}
    </details>
  )
}
