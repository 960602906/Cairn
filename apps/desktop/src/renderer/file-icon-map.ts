/**
 * 文件 / 目录图标的名字匹配：把 `vscode-material-icons` 的整套映射（压缩后约 290 kB）包在这里，
 * 由 `file-icons.tsx` 用动态导入加载。
 *
 * 单独成模块是为了让这份数据不进首屏：界面首帧只需要默认的文件/目录图标，具体图标晚一帧换上也看不出来，
 * 而映射本身要跟着整棵 eager 模块图一起解析就太贵了。
 */
import {
  getIconForDirectoryPath,
  getIconForFilePath,
  getIconUrlByName,
  isMaterialIconName,
} from 'vscode-material-icons'

/** 相对于页面（开发服务器根目录 / 打包后的 renderer 目录）的图标路径。 */
const ICONS_BASE = '.'

/** 按文件名 / 目录名取图标 URL；名字由调用方去掉路径。 */
export interface IconLibrary {
  file(name: string): string
  folder(name: string, expanded: boolean): string
}

/** 文件名对应的 Material 图标 URL。 */
export function fileIconUrl(name: string): string {
  return getIconUrlByName(getIconForFilePath(name), ICONS_BASE)
}

/** 目录名对应的 Material 图标 URL；展开时使用官方 `-open` 变体。 */
export function folderIconUrl(name: string, expanded = false): string {
  const icon = getIconForDirectoryPath(name)
  const openIcon = `${icon}-open`
  return getIconUrlByName(expanded && isMaterialIconName(openIcon) ? openIcon : icon, ICONS_BASE)
}

export const iconLibrary: IconLibrary = { file: fileIconUrl, folder: folderIconUrl }
