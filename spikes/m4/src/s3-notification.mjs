/**
 * S3：Electron 通知探针。
 *
 * 运行：`pnpm --filter @cairn/desktop exec electron ../../spikes/m4/src/s3-notification.mjs`
 * 或在本目录 `npm run s3`（需要能解析 electron）。
 *
 * 记录：Notification 是否受支持、隐藏窗口的焦点 / 可见性、show / failed / click 事件、
 * 以及通知载荷是否含敏感值。系统勿扰模式与点击后聚焦窗口属于交互行为，需要在真实桌面上验证。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Notification } from 'electron'
import { assertNoSecrets, buildNotification, shouldNotify } from './s3-notification-policy.mjs'

const output = process.env.M4_S3_OUT ?? path.join(process.cwd(), 's3-result.json')
const result = {
  platform: process.platform,
  supported: false,
  focused: false,
  visible: false,
  shouldNotify: false,
  events: [],
  error: null,
}

function finish(code) {
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  app.exit(code)
}

app
  .whenReady()
  .then(() => {
    const window = new BrowserWindow({ show: false, width: 800, height: 600 })
    result.supported = Notification.isSupported()
    result.focused = window.isFocused()
    result.visible = window.isVisible()
    const payload = buildNotification({
      agentName: 'builtin.coder',
      sessionTitle: 'S3 spike',
      action: 'approval',
    })
    result.shouldNotify = shouldNotify({
      focused: result.focused,
      visible: result.visible,
      enabled: true,
      now: Date.now(),
    })
    assertNoSecrets(payload, ['sk-live-secret', 'message body', 'C:\\Users\\someone'])

    if (!result.supported) {
      finish(0)
      return
    }

    const notification = new Notification({ ...payload, silent: true })
    const done = setTimeout(() => finish(0), 4000)
    const record = (name) => () => {
      result.events.push(name)
      if (name === 'failed' || name === 'close') {
        clearTimeout(done)
        finish(0)
      }
    }
    notification.on('show', record('show'))
    notification.on('click', record('click'))
    notification.on('close', record('close'))
    notification.on('failed', (event, error) => {
      result.error = String(error ?? event)
      record('failed')()
    })
    notification.show()
  })
  .catch((error) => {
    result.error = String(error)
    finish(1)
  })
