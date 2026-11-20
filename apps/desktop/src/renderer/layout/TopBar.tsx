/**
 * 纸面顶栏（48px）：和对话同一底色，左侧是项目 / 会话面包屑，右侧是会话信息栏开关。
 *
 * 独立成模块：新对话页首屏就要用它，若留在 `ChatPanel` 里会把整个对话页（Markdown、Shiki、
 * diff、右侧工作台）带进首屏，让按视图懒加载失效。
 */
import type { ReactNode } from 'react'
import { TITLE_BAR_INSET } from './WindowControls.js'

export function TopBar({ children }: { readonly children?: ReactNode }) {
  return (
    <header
      className="drag relative flex h-12 shrink-0 items-center gap-1.5 bg-paper pr-3 pl-5"
      style={TITLE_BAR_INSET}
    >
      {children}
      {/* 线条放在顶栏之外，避免被窗口按钮或拖拽区裁切。 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full z-[5] block h-[0.5px] bg-hair"
      />
    </header>
  )
}
