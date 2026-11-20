/**
 * 首帧之后再执行的任务（启动优化）：用 `requestIdleCallback`，环境不支持时退化为短延时。
 * 返回取消函数，组件卸载时调用。
 */
export function onIdle(callback: () => void, timeout = 1000): () => void {
  // 测试环境没有真实的空闲调度，直接执行，保持用例原有的同步语义。
  if (import.meta.env.MODE === 'test') {
    callback()
    return () => undefined
  }
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => callback(), { timeout })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(callback, 200)
  return () => window.clearTimeout(id)
}
