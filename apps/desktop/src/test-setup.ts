/**
 * 渲染进程测试的公共设置。只在 jsdom 环境执行（node 环境的包测试跳过）。
 *
 * 视图按需加载后，用例第一次打开设置/活动页要等一次动态 import；本机冷启动时可能超过
 * Testing Library 默认的 1 秒等待，这里统一放宽到 5 秒。
 */
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react')
  configure({ asyncUtilTimeout: 5000 })
}
