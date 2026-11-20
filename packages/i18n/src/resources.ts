/**
 * 全部文案资源（`locales/<语言>/<命名空间>.json`）。key 为扁平的点分字符串，不嵌套。
 * 两种语言的 key 必须完全一致（M0-11b 的检查脚本在 CI 中校验）。
 *
 * 界面不用这个整体对象：它只带当前语言（`./messages.js` 按需加载），否则首屏要多解析一份用不到的
 * 语言。这里保留完整资源给主进程、测试与组件预览页。
 */
import { messages as enUS } from './en-US.js'
import { messages as zhCN } from './zh-CN.js'
import type { Locale, LocaleMessages } from './namespaces.js'

export const RESOURCES: Readonly<Record<Locale, LocaleMessages>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}
