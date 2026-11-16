/**
 * 应用菜单（M6-02）。
 *
 * 只有 macOS 需要常驻菜单栏：应用、编辑、窗口三项覆盖“关于 / 隐藏 / 退出”“撤销与剪贴板”
 * （⌘Z、⌘C、⌘V、⌘A）与“最小化 / 缩放”。标签与快捷键由 Electron 的 `role` 按系统语言提供，
 * 不在主进程重复翻译。Windows / Linux 的标题栏由界面自绘，保持 Electron 的默认行为。
 */
import type { MenuItemConstructorOptions } from 'electron'

/** macOS 菜单栏；顺序与应用、编辑、窗口的常规布局一致。 */
export function macApplicationMenu(): MenuItemConstructorOptions[] {
  return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]
}

/** 是否需要在启动时设置应用菜单。 */
export const shouldInstallApplicationMenu = (platform: string = process.platform): boolean =>
  platform === 'darwin'
