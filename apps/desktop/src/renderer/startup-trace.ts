/**
 * 首屏计时（PR0，启动优化）。只在开发模式记录：各阶段 mark、首屏长任务、慢 IPC。
 * 生产构建里 mark/慢 IPC 都会被 `import.meta.env.DEV` 消掉；`markReady` 只写一个 data 属性，
 * 供 e2e 等待界面可交互。
 */

const dev = import.meta.env.DEV
const origin = performance.now()
const marks: { name: string; at: number }[] = []

if (dev) {
  const target = globalThis as typeof globalThis & {
    __cairnStartupMarks?: { name: string; at: number }[]
  }
  target.__cairnStartupMarks = marks
}

export function mark(name: string): void {
  if (!dev) return
  const at = performance.now() - origin
  marks.push({ name, at })
  console.info(`[startup] ${name} +${Math.round(at)}ms`)
}

/** 记录首帧提交后的绘制时间。 */
export function markFirstPaint(): void {
  if (!dev) return
  requestAnimationFrame(() => mark('first_paint'))
}

/** 首屏可交互：写一个 data 属性，生产构建也保留（单次属性写入）。 */
export function markReady(): void {
  document.documentElement.dataset['cairnReady'] = String(Math.round(performance.now()))
}

/** 统计首屏长任务（>50ms），用于量化“卡顿感”。 */
export function observeLongTasks(): void {
  if (!dev || typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        console.info(`[startup] longtask ${Math.round(entry.duration)}ms`)
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // 环境不支持 longtask 时静默跳过
  }
}

/** 包装主进程请求，打印超过阈值的 IPC（开发模式）。 */
export function instrumentRequests<T extends object>(api: T): T {
  if (!dev) return api
  const target = api as T & { request: (...args: unknown[]) => Promise<unknown> }
  const original = target.request.bind(api)
  target.request = async (...args: unknown[]) => {
    const started = performance.now()
    try {
      return await original(...args)
    } finally {
      const duration = performance.now() - started
      if (duration > 50) {
        const method = typeof args[0] === 'string' ? args[0] : '?'
        console.info(`[startup] ipc ${method} ${Math.round(duration)}ms`)
      }
    }
  }
  return api
}
