# M4-00 预研

多运行、隔离工作区、活动中心通知与后台命令的预研代码。结论与测量数据见
[`docs/plan/m4-spikes.md`](../../docs/plan/m4-spikes.md)。

## 运行

```powershell
# 仓库根目录
pnpm spike:m4

# 单个预研
pnpm vitest run --config spikes/m4/vitest.config.mts src/s1-multi-run.test.ts --reporter=verbose
pnpm vitest run --config spikes/m4/vitest.config.mts src/s2-worktree.test.ts --reporter=verbose

# S3 Electron 探针（Windows / 带桌面的环境）
$env:M4_S3_OUT="$PWD\spikes\m4\s3-result.json"
& ".\apps\desktop\node_modules\.bin\electron.CMD" ".\spikes\m4\src\s3-notification.mjs"
```

## 文件

| 文件 | 内容 |
|---|---|
| `src/s1-multi-run.test.ts` | 同一 `PiRuntime` 的 3 个会话、事件隔离、独立中止、模型切换与内存测量 |
| `src/s2-worktree.test.ts` | 影子仓库检查点 + `git worktree add --detach`、排除项、非 Git 项目、junction、长路径、清理 |
| `src/s3-notification-policy.mjs` | 通知内容、发送条件与点击路由的纯函数 |
| `src/s3-policy.test.ts` | 通知策略单测 |
| `src/s3-notification.mjs` | Electron `Notification` 探针 |
| `src/s4-background-command.test.ts` | Job Object / 进程组关闭与命令取消清理 |
| `src/fixtures/long-running.mjs` | 写入 PID 后持续运行的测试进程 |

这些文件不进入 pnpm workspace，不参与应用构建；`spike:m4` 使用根目录的 `vitest` 直接运行工作区 TypeScript 源码。
