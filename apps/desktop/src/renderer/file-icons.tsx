/**
 * 文件 / 目录实体图标：用 `vscode-material-icons` 按名称匹配 VS Code Material Icon Theme 的图标。
 * SVG 由 Vite 的 publicDir 复制到构建产物，`<img>` 按需加载，避免把整套图标打进 JS。
 *
 * 匹配用的映射压缩后约 290 kB，由 `file-icon-map.ts` 在首次渲染图标之后动态加载：首帧先给默认的
 * 文件 / 目录图标，映射到位后已经渲染出来的图标自动换成具体图标，不挡首屏。
 *
 * 约定：凡是表示具体文件或目录（文件树、标签、文件列表、卡片标题、附件等）都用这里导出的
 * `FileTypeIcon` / `FolderTypeIcon`；打开文件夹、在资源管理器中显示、新建等操作按钮仍用 Lucide。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { IconLibrary } from './file-icon-map.js'
import { cn } from './ui/index.js'

/** 映射还没加载时用的通用图标（`publicDir` 里始终有这几个）。 */
const FALLBACK_FILE_ICON = './file.svg'
const FALLBACK_FOLDER_ICON = './folder.svg'
const FALLBACK_FOLDER_OPEN_ICON = './folder-open.svg'

let library: IconLibrary | undefined
let started = false
const listeners = new Set<() => void>()

/** 首次渲染图标后开始加载映射；失败时下次挂载再试。 */
function loadLibrary(): void {
  if (started) return
  started = true
  void import('./file-icon-map.js').then(
    (module) => {
      library = module.iconLibrary
      for (const listener of listeners) listener()
    },
    () => {
      started = false
    },
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getLibrary(): IconLibrary | undefined {
  return library
}

function useIconLibrary(): IconLibrary | undefined {
  // 放在 effect 里而不是模块顶层：模块求值属于首屏关键路径，加载 290 kB 不能挤进去。
  useEffect(loadLibrary, [])
  return useSyncExternalStore(subscribe, getLibrary, getLibrary)
}

/** 兼容 Windows 反斜杠与结尾分隔符，图标库自身只按 `/` 拆分路径。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
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
  const icons = useIconLibrary()
  return (
    <span
      aria-hidden
      className={cn('flex size-3.5 shrink-0 items-center justify-center', className)}
    >
      <IconImage src={icons ? icons.file(baseName(name)) : FALLBACK_FILE_ICON} />
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
  const icons = useIconLibrary()
  return (
    <span
      aria-hidden
      className={cn('flex size-3.5 shrink-0 items-center justify-center', className)}
    >
      <IconImage
        src={
          icons
            ? icons.folder(baseName(name), expanded)
            : expanded
              ? FALLBACK_FOLDER_OPEN_ICON
              : FALLBACK_FOLDER_ICON
        }
      />
    </span>
  )
}
