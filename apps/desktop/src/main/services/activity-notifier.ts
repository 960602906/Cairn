/**
 * 活动中心系统通知（M4-06，ADR-0032）。
 *
 * 只在应用不在前台且用户未关闭通知时发送；按会话合并，同一会话在最小间隔内最多一条。通知内容只有
 * 会话标题、Agent 名称与固定动作文案，不包含消息正文、工具参数、路径或凭据。
 */
import type { ActivityChange, ActivityService } from './activity-service.js'

export interface ActivityNotification {
  readonly sessionId: string
  readonly title: string
  readonly body: string
}

export type ActivityNotificationKind = 'approval' | 'completed'

export interface ActivityNotifierOptions {
  readonly activity: Pick<ActivityService, 'subscribe'>
  readonly isForeground: () => boolean
  readonly enabled: () => boolean
  readonly notify: (notification: ActivityNotification) => void
  readonly format: (input: {
    readonly kind: ActivityNotificationKind
    readonly title: string
    readonly agentId: string
  }) => { readonly title: string; readonly body: string }
  readonly now?: () => number
  readonly minIntervalMs?: number
  readonly onError?: (error: unknown) => void
}

export interface ActivityNotifier {
  close(): void
}

export const ACTIVITY_NOTIFICATION_INTERVAL_MS = 15_000

export function createActivityNotifier(options: ActivityNotifierOptions): ActivityNotifier {
  const now = options.now ?? Date.now
  const interval = options.minIntervalMs ?? ACTIVITY_NOTIFICATION_INTERVAL_MS
  const lastSent = new Map<string, number>()

  const send = (
    change: ActivityChange,
    kind: ActivityNotificationKind,
    item: {
      readonly sessionId: string
      readonly sessionTitle: string
      readonly agent: { readonly id: string }
    },
  ): void => {
    try {
      if (!options.enabled() || options.isForeground()) return
      const at = now()
      const previous = lastSent.get(item.sessionId)
      if (previous !== undefined && at - previous < interval) return
      const title = item.sessionTitle || change.sessionId || ''
      const text = options.format({
        kind,
        title,
        agentId: item.agent.id,
      })
      options.notify({ sessionId: item.sessionId, title: text.title, body: text.body })
      lastSent.set(item.sessionId, at)
    } catch (error) {
      options.onError?.(error)
    }
  }

  const unsubscribe = options.activity.subscribe((change) => {
    // 同一会话在同一批变化里最多一条；审批优先于完成。
    const approval = change.approvals[0]
    if (approval) {
      send(change, 'approval', {
        sessionId: approval.sessionId,
        sessionTitle: approval.sessionTitle,
        agent: approval.agent,
      })
      return
    }
    const completed = change.completed[0]
    if (completed) {
      send(change, 'completed', {
        sessionId: completed.sessionId,
        sessionTitle: completed.sessionTitle,
        agent: completed.agent,
      })
    }
  })

  return {
    close() {
      unsubscribe()
      lastSent.clear()
    },
  }
}
