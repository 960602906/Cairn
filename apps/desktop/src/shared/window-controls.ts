/**
 * Windows / Linux 自绘窗口按钮的 IPC 通道。
 *
 * macOS 保留系统红绿灯；其他平台不再使用 `titleBarOverlay`，避免原生按钮浮在应用弹窗遮罩之上、
 * 露出一块与主题不一致的底色。这里的通道只接受无参数的最小化 / 最大化 / 关闭，不暴露任意 IPC。
 */

export const WINDOW_CONTROLS_CHANNEL = {
  minimize: 'cairn:window:minimize',
  toggleMaximize: 'cairn:window:toggle-maximize',
  close: 'cairn:window:close',
  isMaximized: 'cairn:window:is-maximized',
  maximizedChanged: 'cairn:window:maximized-changed',
} as const
