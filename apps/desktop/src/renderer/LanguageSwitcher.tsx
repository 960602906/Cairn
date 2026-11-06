/**
 * 语言切换（M0-15d）：选择后立即切换界面语言，再交给 `onSave` 保存到设置（没有 preload 时只切换）。
 * 保存失败时界面保持新语言，错误由 store 显示；下次启动仍使用之前保存的语言。
 */
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LOCALES, type Locale } from '@cairn/i18n'

export function LanguageSwitcher({ onSave }: { readonly onSave?: (locale: Locale) => void }) {
  const { t, i18n } = useTranslation()
  const change = (locale: Locale) => {
    void i18n.changeLanguage(locale)
    onSave?.(locale)
  }
  return (
    <label>
      {t('language.label')}
      {/* 选项只有支持的语言 */}
      <select value={i18n.language} onChange={(e) => change(e.target.value as Locale)}>
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {t(`language.${locale}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
