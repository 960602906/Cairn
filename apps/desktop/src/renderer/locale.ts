/**
 * 界面语言（M0-15d，架构 §19）。启动时向主进程读取设置中的语言（没有保存过时主进程按系统语言
 * 检测）；没有 preload 或读取失败时按浏览器语言检测。切换语言即时生效，并同步 `<html lang>`。
 */
import {
  DEFAULT_NAMESPACE,
  detectLocale,
  loadMessages,
  type I18nInstance,
  type Locale,
} from '@cairn/i18n'
import type { MainApi } from './api.js'

export async function loadLocale(
  api: Pick<MainApi, 'request'> | undefined,
  systemLocales: readonly string[],
): Promise<Locale> {
  if (api) {
    try {
      return (await api.request('settings.get', {})).locale
    } catch {
      // 读取失败不阻止界面启动
    }
  }
  return detectLocale(systemLocales)
}

/** 让 `<html lang>` 跟随当前语言；返回取消跟随的函数。 */
export function syncDocumentLang(
  i18n: I18nInstance,
  root: { lang: string } = document.documentElement,
): () => void {
  // supportedLngs 限定了可切换的语言，不支持的语言会回退为支持的语言
  const apply = (lng: string) => {
    root.lang = lng
  }
  apply(i18n.language)
  i18n.on('languageChanged', apply)
  return () => i18n.off('languageChanged', apply)
}

/**
 * 切换界面语言。另一种语言的文案还没有加载时先取（首次切换会有一次本地分块的读取），
 * 之后再切换就是纯内存操作。
 */
export async function switchLocale(i18n: I18nInstance, locale: Locale): Promise<void> {
  if (!i18n.hasResourceBundle(locale, DEFAULT_NAMESPACE)) {
    const { messages } = await loadMessages(locale)
    for (const [namespace, bundle] of Object.entries(messages)) {
      i18n.addResourceBundle(locale, namespace, bundle)
    }
  }
  await i18n.changeLanguage(locale)
}
