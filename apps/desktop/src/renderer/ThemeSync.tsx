/**
 * 让界面主题跟随设置（M2-01）：启动时读取设置，之后设置中的主题变化即时生效。
 * 没有设置过主题时跟随系统。不渲染任何内容。
 */
import { useEffect } from 'react'
import { useSessionStore } from './store-context.js'
import { applyTheme, type ThemeEnvironment } from './theme.js'

export function ThemeSync({ env }: { readonly env?: ThemeEnvironment }) {
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const theme = useSessionStore((s) => s.settings?.theme ?? 'system')

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => applyTheme(theme, env), [theme, env])
  return null
}
