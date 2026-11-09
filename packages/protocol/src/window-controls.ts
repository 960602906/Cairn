/** preload 暴露给界面的窗口按钮 API（Windows / Linux）。 */
export interface WindowControlsApi {
  /** `process.platform`：`darwin` 时不渲染自绘按钮。 */
  readonly platform: string
  minimize(): Promise<void>
  /** 切换最大化并返回切换后的状态。 */
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** 最大化状态变化；返回取消订阅函数。 */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}
