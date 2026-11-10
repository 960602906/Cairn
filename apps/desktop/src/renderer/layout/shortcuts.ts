/** 快捷键（M2-02）：macOS 用 ⌘，其他平台用 Ctrl。 */

export const isMacPlatform = (platform: string = navigator.platform): boolean =>
  platform.toLowerCase().startsWith('mac')

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
