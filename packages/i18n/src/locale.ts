import { SUPPORTED_LOCALES, type Locale } from './resources.js'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * 首次启动时的语言（架构 §19）：系统首选语言为中文时用 `zh-CN`，其他一律 `en-US`。
 * 传入系统语言列表（主进程用 `app.getPreferredSystemLanguages()`，回退 `app.getLocale()`），只看第一个。
 */
export function detectLocale(systemLocales: readonly string[]): Locale {
  const first = systemLocales.find((l) => l.trim() !== '')
  return first !== undefined && /^zh(?:[-_]|$)/i.test(first.trim()) ? 'zh-CN' : 'en-US'
}

/** 设置中保存的语言优先，无效时按系统语言检测。 */
export function resolveLocale(saved: unknown, systemLocales: readonly string[]): Locale {
  return isLocale(saved) ? saved : detectLocale(systemLocales)
}
