/**
 * 文件 / 目录实体图标：用 `vscode-material-icons` 按名称匹配 VS Code Material Icon Theme 的图标。
 * SVG 由 Vite 的 publicDir 复制到构建产物，`<img>` 按需加载，避免把整套图标打进 JS。
 *
 * 约定：凡是表示具体文件或目录（文件树、标签、文件列表、卡片标题、附件等）都用这里导出的
 * `FileTypeIcon` / `FolderTypeIcon`；打开文件夹、在资源管理器中显示、新建等操作按钮仍用 Lucide。
 */
import {
  getIconForDirectoryPath,
  getIconForFilePath,
  getIconUrlByName,
  isMaterialIconName,
} from 'vscode-material-icons'
import { cn } from './ui/index.js'

/** 相对于页面（开发服务器根目录 / 打包后的 renderer 目录）的图标路径。 */
const ICONS_BASE = '.'

/** 兼容 Windows 反斜杠与结尾分隔符，图标库自身只按 `/` 拆分路径。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** 文件名对应的 Material 图标 URL。 */
export function fileIconUrl(path: string): string {
  return getIconUrlByName(getIconForFilePath(baseName(path)), ICONS_BASE)
}

/** 目录名对应的 Material 图标 URL；展开时使用官方 `-open` 变体。 */
export function folderIconUrl(path: string, expanded = false): string {
  const icon = getIconForDirectoryPath(baseName(path))
  const openIcon = `${icon}-open`
  return getIconUrlByName(expanded && isMaterialIconName(openIcon) ? openIcon : icon, ICONS_BASE)
}

function IconImage({ src }: { readonly src: string }) {
  return <img src={src} alt="" draggable={false} className="size-full" />
}

export function FileTypeIcon({
  name,
  className,
}: {
  readonly name: string
  readonly className?: string | undefined
}) {
  return (
    <span aria-hidden className={cn('flex size-3.5 shrink-0 items-center justify-center', className)}>
      <IconImage src={fileIconUrl(name)} />
    </span>
  )
}

export function FolderTypeIcon({
  name,
  expanded = false,
  className,
}: {
  readonly name: string
  readonly expanded?: boolean | undefined
  readonly className?: string | undefined
}) {
  return (
    <span aria-hidden className={cn('flex size-3.5 shrink-0 items-center justify-center', className)}>
      <IconImage src={folderIconUrl(name, expanded)} />
    </span>
  )
}
