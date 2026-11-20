/**
 * 文案资源的语言与命名空间。单独成文件：界面只要这些类型与常量，不该为此加载两种语言的文案。
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const NAMESPACES = [
  'common',
  'session',
  'settings',
  'agents',
  'trial',
  'onboarding',
  'errors',
] as const
export type Namespace = (typeof NAMESPACES)[number]

export const DEFAULT_NAMESPACE: Namespace = 'common'
export const FALLBACK_LOCALE: Locale = 'en-US'

export type Messages = Readonly<Record<string, string>>

/** 一种语言的全部命名空间（`locales/<语言>/<命名空间>.json`）。 */
export type LocaleMessages = Readonly<Record<Namespace, Messages>>
