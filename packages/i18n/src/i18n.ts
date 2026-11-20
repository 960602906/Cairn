/**
 * 完整资源版本的实例创建：一次带上两种语言，主进程、测试与组件预览页用。
 * 界面走 `createI18nInstance` + `loadMessages`，只加载当前语言。
 */
import type { i18n as I18nInstance } from 'i18next'
import { createI18nInstance } from './instance.js'
import { FALLBACK_LOCALE, type Locale } from './namespaces.js'
import { RESOURCES } from './resources.js'

export {
  createI18nInstance,
  translateError,
  type ErrorLike,
  type I18nInstance,
  type TFunction,
} from './instance.js'

/** 创建一个已初始化的独立实例（同步，资源随包内置，含回退语言）。 */
export function createI18n(locale: Locale): I18nInstance {
  return createI18nInstance(locale, RESOURCES, FALLBACK_LOCALE)
}
