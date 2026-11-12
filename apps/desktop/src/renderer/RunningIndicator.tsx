/**
 * 运行指示（聊天区状态显示优化方案 §3.2）：环石 C 旋转 + 一句“当前在干什么”。
 *
 * 只在空白期出现 —— 已经发出、但界面上还没有正文或正在执行的工具时，
 * 用它填补消息列末尾，避免只剩用户气泡、下方一片空白。文字由调用方按运行阶段给出。
 * 不加 `role="status"`：页面唯一的运行状态播报点在 `ChatPanel`。
 */
import { CairnMark, Shimmer } from './ui/index.js'

export function RunningIndicator({ text }: { readonly text: string }) {
  return (
    <div data-running-status className="flex items-center gap-2 text-ui text-muted">
      <span
        aria-hidden
        className="grid animate-spin place-items-center text-accent"
        style={{ animationDuration: '1.4s' }}
      >
        <CairnMark size={15} />
      </span>
      <Shimmer>{text}</Shimmer>
    </div>
  )
}
