/**
 * 退出守卫：记录应用是否已开始退出，决定此时还能不能建窗口。
 *
 * macOS 上关闭所有窗口不会退出进程；`before-quit` 之后还要等宿主结束（最长数秒）才真正退出。
 * 这段时间里点 Dock 图标会触发 `activate`，若此时再建窗口，会在数据库已关闭后读设置，抛出
 * "The database connection is not open"。一旦开始退出就不再建任何窗口。
 *
 * 纯逻辑，不依赖 Electron，便于测试。
 */
export interface QuitGuard {
  /** 开始退出；可重复调用（`before-quit` 会触发两次）。 */
  begin(): void
  /** 是否已开始退出。 */
  isQuitting(): boolean
  /** 现在能否创建窗口。 */
  canCreateWindow(): boolean
  /** `activate` 时是否需要新建窗口：未在退出，且当前没有任何窗口。 */
  shouldCreateOnActivate(openWindowCount: number): boolean
}

export function createQuitGuard(): QuitGuard {
  let quitting = false
  return {
    begin: () => {
      quitting = true
    },
    isQuitting: () => quitting,
    canCreateWindow: () => !quitting,
    shouldCreateOnActivate: (openWindowCount) => !quitting && openWindowCount === 0,
  }
}
