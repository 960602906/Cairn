/**
 * @nexus/i18n —— 文案资源与工具函数（ADR-0013，架构 §19）。
 * 在 M0-11 实现。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
