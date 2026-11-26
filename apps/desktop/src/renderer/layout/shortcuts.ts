/** 快捷键（M2-02）：macOS 用 ⌘，其他平台用 Ctrl。 */

export const isMacPlatform = (platform: string = navigator.platform): boolean =>
  platform.toLowerCase().startsWith('mac')

/** 请求聚焦输入框的窗口事件：`⌘L` 由根组件派发，当前挂载的输入框自行响应。 */
export const COMPOSER_FOCUS_EVENT = 'cairn:focus-composer'

/** “新对话”的快捷键提示。 */
export const newChatShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘N' : 'Ctrl N'

/** 按键是否为“新对话”（⌘N / Ctrl+N，不带 Shift 与 Alt）。 */
export function isNewChatKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n'
}

/** “设置”的快捷键提示（M2-09）。 */
export const settingsShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘,' : 'Ctrl ,'

/** 按键是否为“设置”（⌘, / Ctrl+,，不带 Shift 与 Alt）。 */
export function isSettingsKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key === ','
}

/** “切换 Agent”的快捷键提示（M6-08）。 */
export const agentPickerShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘.' : 'Ctrl .'

/** 按键是否为“切换 Agent”（⌘. / Ctrl+.，不带 Shift 与 Alt）。 */
export function isAgentPickerKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key === '.'
}

/** “搜索对话”的快捷键提示（M2-12）。 */
export const searchShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘K' : 'Ctrl K'

/** 按键是否为“搜索对话”（⌘K / Ctrl+K，不带 Shift 与 Alt）。 */
export function isSearchKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k'
}

/** “在对话中查找”的快捷键提示。 */
export const findShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘F' : 'Ctrl F'

/** 按键是否为“在对话中查找”（⌘F / Ctrl+F，不带 Shift 与 Alt）。 */
export function isFindKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f'
}

/** “切换计划模式”的快捷键提示（⌘⇧P / Ctrl+Shift+P）。 */
export const planShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘⇧P' : 'Ctrl Shift P'

/** 按键是否为“切换计划模式”（⌘⇧P / Ctrl+Shift+P）。 */
export function isPlanModeKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p'
}

/** “聚焦输入框”的快捷键提示。 */
export const focusComposerShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘L' : 'Ctrl L'

/** 按键是否为“聚焦输入框”（⌘L / Ctrl+L，不带 Shift 与 Alt）。 */
export function isFocusComposerKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l'
}

/** “收起或展开侧栏”的快捷键提示。 */
export const toggleSidebarShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘B' : 'Ctrl B'

/** 按键是否为“收起或展开侧栏”（⌘B / Ctrl+B，不带 Shift 与 Alt）。 */
export function isToggleSidebarKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b'
}

/** “收起或展开工作台”的快捷键提示。 */
export const toggleWorkbenchShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘J' : 'Ctrl J'

/** 按键是否为“收起或展开工作台”（⌘J / Ctrl+J，不带 Shift 与 Alt）。 */
export function isToggleWorkbenchKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j'
}

/**
 * “上一个 / 下一个会话”的快捷键提示。带 Shift 的方括号在多数键盘布局上会变成花括号，
 * 因此按键判断同时接受 `[`/`{` 与 `]`/`}`。
 */
export const sessionCycleShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘⇧[ / ⌘⇧]' : 'Ctrl Shift [ / ]'

const isSessionCycleEvent = (
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean => {
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey
  return mod && event.shiftKey && !event.altKey
}

/** 按键是否为“上一个会话”（⌘⇧[ / Ctrl+Shift+[）。 */
export function isPreviousSessionKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  return isSessionCycleEvent(event, platform) && (event.key === '[' || event.key === '{')
}

/** 按键是否为“下一个会话”（⌘⇧] / Ctrl+Shift+]）。 */
export function isNextSessionKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform?: string,
): boolean {
  return isSessionCycleEvent(event, platform) && (event.key === ']' || event.key === '}')
}

/** “放大 / 缩小 / 实际大小”的快捷键提示（主进程走 `before-input-event`）。 */
export const zoomShortcut = (platform?: string): string =>
  isMacPlatform(platform) ? '⌘+ / ⌘- / ⌘0' : 'Ctrl + / - / 0'

/**
 * 在会话列表里按给定方向找相邻的会话：到头后回绕；当前会话不在列表里（例如刚归档）时回到第一个。
 * 列表顺序就是侧栏与搜索使用的顺序。
 */
export function adjacentSessionId(
  sessions: readonly { readonly sessionId: string }[],
  activeSessionId: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (sessions.length === 0) return undefined
  const index =
    activeSessionId === undefined
      ? -1
      : sessions.findIndex((session) => session.sessionId === activeSessionId)
  if (index === -1) return sessions[0]?.sessionId
  return sessions[(index + delta + sessions.length) % sessions.length]?.sessionId
}
