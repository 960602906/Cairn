/**
 * 文案资源（`locales/<语言>/<命名空间>.json`）。key 为扁平的点分字符串，不嵌套。
 * 两种语言的 key 必须完全一致（M0-11b 的检查脚本在 CI 中校验）。
 */
import enCommon from '../locales/en-US/common.json' with { type: 'json' }
import enErrors from '../locales/en-US/errors.json' with { type: 'json' }
import enSession from '../locales/en-US/session.json' with { type: 'json' }
import zhCommon from '../locales/zh-CN/common.json' with { type: 'json' }
import zhErrors from '../locales/zh-CN/errors.json' with { type: 'json' }
import zhSession from '../locales/zh-CN/session.json' with { type: 'json' }

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const NAMESPACES = ['common', 'session', 'errors'] as const
export type Namespace = (typeof NAMESPACES)[number]

export const DEFAULT_NAMESPACE: Namespace = 'common'
export const FALLBACK_LOCALE: Locale = 'en-US'

export type Messages = Readonly<Record<string, string>>

export const RESOURCES: Readonly<Record<Locale, Readonly<Record<Namespace, Messages>>>> = {
  'zh-CN': { common: zhCommon, session: zhSession, errors: zhErrors },
  'en-US': { common: enCommon, session: enSession, errors: enErrors },
}
