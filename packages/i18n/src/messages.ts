/**
 * 按需加载一种语言的文案。界面只带当前语言，另一种在切换语言时再取（首屏少约 100 kB）。
 */
import type { Locale, LocaleMessages } from './namespaces.js'

const loaders: Record<Locale, () => Promise<{ messages: LocaleMessages }>> = {
  'zh-CN': () => import('./zh-CN.js'),
  'en-US': () => import('./en-US.js'),
}

export function loadMessages(locale: Locale): Promise<{ messages: LocaleMessages }> {
  return loaders[locale]()
}
