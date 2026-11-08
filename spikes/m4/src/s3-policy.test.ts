import { describe, expect, it } from 'vitest'
import {
  assertNoSecrets,
  buildNotification,
  notificationTarget,
  shouldNotify,
} from './s3-notification-policy.mjs'

describe('S3 通知内容与发送条件', () => {
  it('只包含 Agent、会话标题与动作，不包含消息正文与凭据', () => {
    const payload = buildNotification({
      agentName: 'builtin.coder',
      sessionTitle: '修复登录页',
      action: 'approval',
    })
    expect(payload).toEqual({
      title: 'Cairn · builtin.coder',
      body: '修复登录页：等待审批',
    })
    expect(() =>
      assertNoSecrets(payload, ['sk-live-secret', '用户的完整消息正文', 'C:\\Users\\someone']),
    ).not.toThrow()
  })

  it('拒绝未知动作', () => {
    expect(() =>
      buildNotification({ agentName: 'a', sessionTitle: 'b', action: 'unknown' }),
    ).toThrow('unknown notification action')
  })

  it('前台、禁用与最小间隔内不发送', () => {
    const base = { focused: false, visible: false, enabled: true, now: 100_000 }
    expect(shouldNotify({ ...base, focused: true, visible: true })).toBe(false)
    expect(shouldNotify({ ...base, enabled: false })).toBe(false)
    expect(shouldNotify({ ...base, lastNotifiedAt: 90_000 })).toBe(false)
    expect(shouldNotify({ ...base, lastNotifiedAt: 85_000 })).toBe(true)
    expect(shouldNotify(base)).toBe(true)
    // 窗口不可见但仍有焦点（最小化到托盘）时仍然通知
    expect(shouldNotify({ ...base, focused: true, visible: false })).toBe(true)
  })

  it('点击通知只路由 sessionId', () => {
    expect(notificationTarget({ sessionId: 's-1' })).toEqual({ sessionId: 's-1' })
  })
})
