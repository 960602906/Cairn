/**
 * 语言切换（M0-15d）：选择后立即切换界面语言。只在没有 preload（如在普通浏览器中打开）时显示；
 * 正常运行时语言在设置页“通用与外观”中切换并保存（M2-09）。
 */
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LOCALES, type Locale } from '@cairn/i18n'

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation()
  return (
    <label>
      {t('language.label')}
      {/* 选项只有支持的语言 */}
      <select
        value={i18n.language}
        onChange={(e) => void i18n.changeLanguage(e.target.value as Locale)}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {t(`language.${locale}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
