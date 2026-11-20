/**
 * i18next 实例与错误码翻译（ADR-0013）。主进程（菜单、对话框、通知）与界面共用。
 * 界面侧由 react-i18next 包装同一个实例（M0-12）。
 *
 * 这里不引用 `./resources.js`：界面用 `createI18nInstance` 只交进当前语言的文案，
 * 避免为了建实例把另一种语言也打进首屏。
 */
import i18next, { type i18n as I18nInstance, type TFunction } from 'i18next'
import {
  DEFAULT_NAMESPACE,
  NAMESPACES,
  SUPPORTED_LOCALES,
  type Locale,
  type LocaleMessages,
} from './namespaces.js'

export type { I18nInstance, TFunction }

/** 进程间传递的错误（与 `@cairn/protocol` 的 `ErrorInfo` 结构相同；i18n 不依赖其他包）。 */
export interface ErrorLike {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined
}

/**
 * 用给定的资源创建一个已初始化的独立实例（同步）。
 * `resources` 可以只含当前语言：缺 key 时按 `fallbackLocale` 回退，回退语言没带就显示 key 本身。
 */
export function createI18nInstance(
  locale: Locale,
  resources: Readonly<Partial<Record<Locale, LocaleMessages>>>,
  fallbackLocale: Locale = locale,
): I18nInstance {
  const instance = i18next.createInstance()
  void instance.init({
    lng: locale,
    fallbackLng: fallbackLocale,
    supportedLngs: [...SUPPORTED_LOCALES],
    resources,
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    // key 为扁平的点分字符串（如 `status.idle`、`storage.not_found`）
    keySeparator: false,
    initAsync: false,
    returnNull: false,
    // React 会转义；主进程的原生对话框不解析 HTML
    interpolation: { escapeValue: false },
  })
  return instance
}

/** 把错误码翻译为当前语言的文案；没有对应文案时显示带错误码的通用提示。 */
export function translateError(i18n: I18nInstance, error: ErrorLike): string {
  const ns = 'errors'
  if (i18n.exists(error.code, { ns })) return i18n.t(error.code, { ns, ...error.params })
  return i18n.t('unknown', { ns, code: error.code })
}
