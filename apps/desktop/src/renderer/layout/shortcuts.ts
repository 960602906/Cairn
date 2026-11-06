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
