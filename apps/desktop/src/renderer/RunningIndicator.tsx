/**
 * 运行指示（聊天区状态显示优化方案 §3.2）：转圈的缺口圆 + 一句“当前在干什么”。
 *
 * 只在空白期出现 —— 已经发出、但界面上还没有正文或正在执行的工具时，
 * 用它填补消息列末尾，避免只剩用户气泡、下方一片空白。文字由调用方按运行阶段给出。
 * 消息列末尾已经有组头时不再出现：状态由组头那一行承担，两行说同一件事只是噪音。
 * 不加 `role="status"`：页面唯一的运行状态播报点在 `ChatPanel`。
 */
import { LoaderCircle } from 'lucide-react'
import { Shimmer } from './ui/index.js'

export function RunningIndicator({ text }: { readonly text: string }) {
  return (
    <div data-running-status className="flex items-center gap-2 text-ui text-muted">
      <LoaderCircle
        aria-hidden
        className="size-4 shrink-0 animate-spin text-accent"
        strokeWidth={2.4}
        style={{ animationDuration: '1.4s' }}
      />
      <Shimmer>{text}</Shimmer>
    </div>
  )
}
