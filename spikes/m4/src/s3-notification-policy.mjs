/**
 * S3：活动中心通知的内容与发送条件（预研实现，不进入产品代码）。
 *
 * 通知只用于“把用户带回需要处理的会话”，因此：
 * - 标题与正文只包含 Agent 名称、会话标题与固定的动作文案，不包含消息正文、工具参数、文件内容或凭据；
 * - 窗口在前台、被禁用、或距上次通知不足最小间隔时不发送（按会话合并，避免通知风暴）；
 * - 点击通知只携带 sessionId，由主进程路由到对应会话。
 */

export const NOTIFICATION_MIN_INTERVAL_MS = 15_000

/**
 * @param {{ agentName: string, sessionTitle: string, action: 'approval' | 'completed' | 'failed' }} input
 * @returns {{ title: string, body: string, sessionId?: string }}
 */
export function buildNotification(input) {
  const action = {
    approval: '等待审批',
    completed: '运行已完成',
    failed: '运行失败',
  }[input.action]
  if (!action) throw new Error(`unknown notification action: ${input.action}`)
  return {
    title: `Cairn · ${input.agentName}`,
    body: `${input.sessionTitle}：${action}`,
  }
}

/**
 * @param {{
 *   focused: boolean,
 *   visible: boolean,
 *   enabled: boolean,
 *   now: number,
 *   lastNotifiedAt?: number,
 *   minIntervalMs?: number
 * }} input
 */
export function shouldNotify(input) {
  if (!input.enabled) return false
  if (input.focused && input.visible) return false
  const minInterval = input.minIntervalMs ?? NOTIFICATION_MIN_INTERVAL_MS
  return input.lastNotifiedAt === undefined || input.now - input.lastNotifiedAt >= minInterval
}

/**
 * 点击通知后的路由目标：只有会话 id，没有 URL、文件路径或消息内容。
 * @param {{ sessionId: string }} input
 */
export function notificationTarget(input) {
  return { sessionId: input.sessionId }
}

/**
 * 断言通知载荷不包含任何敏感值；由测试与 Electron 探针共用。
 * @param {unknown} payload
 * @param {readonly string[]} secrets
 */
export function assertNoSecrets(payload, secrets) {
  const text = JSON.stringify(payload)
  for (const secret of secrets) {
    if (secret !== '' && text.includes(secret)) {
      throw new Error('notification payload contains a secret')
    }
  }
}
