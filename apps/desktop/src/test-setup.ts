/**
 * 渲染进程测试的公共设置。只在 jsdom 环境执行（node 环境的包测试跳过）。
 *
 * 视图按需加载后，用例第一次打开设置/活动页要等一次动态 import；本机冷启动时可能超过
 * Testing Library 默认的 1 秒等待，这里统一放宽到 5 秒。
 */
import { afterEach } from 'vitest'

if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react')
  configure({ asyncUtilTimeout: 5000 })

  // 输入框草稿、侧栏宽度等界面偏好写在 localStorage；同一文件的用例之间不要互相带着走。
  afterEach(() => {
    try {
      window.localStorage.clear()
    } catch {
      // 隐私模式或未实现 localStorage 的环境里本来就没有状态。
    }
  })
}
