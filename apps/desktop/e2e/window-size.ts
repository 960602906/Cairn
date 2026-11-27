import type { ElectronApplication, Page } from '@playwright/test'

export interface WindowSize {
  readonly width: number
  readonly height: number
}

/**
 * 把窗口内容区调整到目标尺寸，并以系统实际允许的尺寸为准。
 *
 * 小屏幕（例如 Retina 缩放后约 1280×800 的逻辑工作区）会把过大的目标钳制；此前测试直接断言
 * 目标值会一直等到超时。这里先设置，再读取窗口真正生效的内容尺寸，页面按实际尺寸校验布局。
 */
export async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  size: WindowSize,
): Promise<WindowSize> {
  const actual = await app.evaluate(async ({ BrowserWindow }, next) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return next
    window.setContentSize(next.width, next.height)
    // 等窗口管理器应用约束（最大尺寸 / 工作区）后再读实际值。
    await new Promise((resolve) => setTimeout(resolve, 150))
    const [width, height] = window.getContentSize()
    return { width: width ?? next.width, height: height ?? next.height }
  }, size)
  await page.waitForFunction(
    (next) => {
      const view = globalThis as unknown as { innerWidth: number; innerHeight: number }
      return view.innerWidth === next.width && view.innerHeight === next.height
    },
    actual,
    { timeout: 5_000 },
  )
  return actual
}
