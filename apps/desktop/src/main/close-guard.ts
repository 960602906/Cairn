/**
 * 关窗保护：Windows / Linux 上关闭窗口等于退出应用，正在运行的会话会被中断，
 * 因此有关键运行时要先确认。macOS 关闭窗口只是收起窗口，应用和运行都还在，不需要确认。
 *
 * 纯逻辑，不依赖 Electron。
 */
export function shouldConfirmClose(platform: string, runningCount: number): boolean {
  return platform !== 'darwin' && runningCount > 0
}
