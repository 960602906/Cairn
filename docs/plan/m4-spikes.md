# M4-00 预研报告

> 状态：已完成（Windows 本地实测；Ubuntu 由 `.github/workflows/spike-m4.yml` 在 PR 中运行）。
> 上级文档：[M4 计划](m4.md)。预研代码：[`spikes/m4`](../../spikes/m4/README.md)。

## 1. 结论

| 预研 | 结论 | 对计划的影响 |
|---|---|---|
| S1 同一宿主多运行 | **采用**：一个宿主内创建 3 个独立 pi 会话，事件、模型与历史互不干扰；中止一个会话不影响其他会话 | M4-01 按“一个 `RunSupervisor` 管理 N 个运行”实现，不改为“每个子运行一个宿主” |
| S2 隔离工作区 | **采用**：影子仓库检查点 + `git worktree add --detach` 在 Windows 上与现有影子仓库兼容；排除规则、非 Git 项目、junction、长路径与清理均通过 | M4-08 直接复用 `openShadowRepo` 的检查点提交；“从影子提交导出”保留为异常文件系统上的回退 |
| S3 活动中心通知 | **采用**：Electron `Notification` 在 Windows 上受支持并能触发 `show`；内容策略可以做到不含消息正文与凭据 | M4-06 用主进程聚合 + 焦点判断 + 按会话合并；勿扰模式与点击聚焦留到真实桌面验收 |
| S4 后台命令 | **采用（保留 M4-14 可选）**：关闭 Job Object 句柄等价于应用退出，会结束整个进程树；取消命令也会清理子进程 | M4-14 仍然不阻塞 M4 完成标准；后台命令服务需要显式的长生命周期，而不是复用“命令结束即清理” |

## 2. 环境

| 项目 | 值 |
|---|---|
| 本地系统 | Windows（`process.platform = win32`） |
| Node | 26.13.0 |
| Git | 2.47.0.windows.2 |
| Electron | 45.2.1（`apps/desktop` 的依赖） |
| 预研运行方式 | `pnpm spike:m4`；S3 Electron 探针单独运行 |

预研代码不进入 pnpm workspace，不参与应用构建；根目录的 `pnpm spike:m4` 只借用根 `vitest`，直接运行工作区 TypeScript 源码。

## 3. S1 同一宿主多运行

### 3.1 假设

同一个 `PiRuntime` 可以在一个进程内持有 3 个会话，每个会话有自己的模型、事件流、历史与中止信号；一个会话中止不会影响其他会话。

### 3.2 方法

`spikes/m4/src/s1-multi-run.test.ts`：

1. 启动本地 OpenAI 兼容 mock 端点，返回 3 段流式回复。
2. 用一个 `PiRuntime` 创建 3 个会话，模型 id 分别为 `spike-model-0/1/2`。
3. 并行 `prompt`，收集每个会话的运行时事件、历史长度与 mock 收到的请求。
4. 另一个用例让一个会话的连接一直不结束，中止它，并检查另一个会话正常完成。

### 3.3 结果（2026-11-08，Windows）

```text
M4_S1_RESULT {"sessions":3,"durationMs":155,"cpuMs":156,"rssDeltaBytes":19156992,"requests":3}
```

- 3 个会话并行完成耗时 155 ms，CPU 时间 156 ms。
- 并行请求期间 RSS 增量约 18.3 MiB（包含 HTTP 客户端、解析与模型注册；不是泄漏测试）。
- 每个会话恰好一个 `loop.ended { outcome: 'completed' }`、一个 `message.completed`，历史长度 2（用户 + 助手）。
- mock 收到 3 个请求，模型 id 分别为 3 个不同值，说明每个会话使用自己的模型绑定。
- 中止挂起的会话后，它只产生 `loop.ended { outcome: 'aborted' }`，另一个会话仍然 `completed`。

### 3.4 结论

**go。** M4-01 可以在同一宿主内管理多个运行。需要注意：

- RSS 增量不是线性结论；并行子运行的实际内存上限在 M4-13 用 3 会话 × 2 子运行压测。
- 每个运行必须自己持有 `AbortController` 与运行时会话，不能共享 `RunEngine`。
- 事件仍由主进程统一分配 `seq`；宿主只保证同一会话内的事件顺序。

## 4. S2 隔离工作区

### 4.1 假设

以影子仓库的检查点提交为基线，可以在 Windows 上用 `git worktree add --detach` 创建一个隔离工作区，并且：

- 未提交改动进入基线；
- `node_modules`、超大文件、嵌套仓库不进入工作区；
- 主工作区不受子工作区改动影响；
- 非 Git 项目同样可用；
- 可以通过 junction 复用只读依赖；
- 长路径可用；
- 清理后没有残留。

### 4.2 方法

`spikes/m4/src/s2-worktree.test.ts` 使用真实的 `@cairn/checkpoint`：

1. 创建项目：源码、`node_modules`、2 MiB 大文件、CRLF 文件、带提交的嵌套仓库；用户仓库有一个提交后又修改了源码。
2. `openShadowRepo` 创建检查点（`maxFileBytes = 1 MiB`，额外排除 `node_modules/`）。
3. 用 `git --git-dir <shadow> --work-tree <project> worktree add --detach <dest> <checkpoint>`。
4. 检查文件内容、CRLF、排除项、`status` 干净、子工作区改动与主工作区隔离。
5. 另一个用例不使用用户 Git 仓库，并加入 10 段长路径与 `node_modules` junction。
6. `git worktree remove --force` + `git worktree prune` 后检查目录不存在。

### 4.3 结果（2026-11-08，Windows）

```text
M4_S2_RESULT {"platform":"win32","checkoutMs":84,"worktreeFiles":3,"projectFiles":7}
```

- 84 ms 完成检出；工作区只包含 3 个应快照文件，`node_modules`、大文件与嵌套仓库都不在。
- 未提交的 `export const value = 2` 出现在隔离工作区；CRLF 字节原样保留。
- 在隔离工作区修改源码与新增测试文件后，`git status` 能识别两处改动；主工作区仍然是 `value = 2`，也没有新文件。
- 隔离工作区的 `.git` 是文件（指向影子仓库的 worktree 元数据），用户项目没有被写入。
- 非 Git 项目、10 段长路径、`node_modules` junction 全部通过。
- `git worktree remove --force` 后目录消失，`worktree prune` 成功。

### 4.4 结论

**go。** M4-08 采用“影子仓库检查点 + worktree”。保留以下边界：

- 嵌套仓库不在检查点内，因此也不会出现在隔离工作区；界面必须说明它不受保护。
- `node_modules` 需要由隔离工作区服务显式创建 junction / symlink，Git 不会复制它。
- 极端文件系统（不支持 worktree、路径过长、权限异常）回退到“从影子提交导出到独立目录”；导出方式在 M4-08 实现时补测试。
- 同一项目的多个 worktree 共享影子仓库对象与索引锁；M4-08 需要沿用现有的锁重试策略，并为每个子运行使用独立 worktree 目录。

## 5. S3 活动中心通知

### 5.1 假设

Electron `Notification` 可用于“应用不在前台时提醒用户审批”；通知内容可以限制为 Agent、会话标题与动作，不泄露消息正文、文件内容或凭据；点击通知只携带会话 id。

### 5.2 方法

- `spikes/m4/src/s3-notification-policy.mjs`：通知载荷、发送条件（前台 / 可见性 / 开关 / 最小间隔）与点击路由的纯函数。
- `spikes/m4/src/s3-policy.test.ts`：4 个用例覆盖内容、未知动作、发送条件与路由。
- `spikes/m4/src/s3-notification.mjs`：Electron 探针，创建隐藏窗口，读取焦点 / 可见性，调用 `Notification.isSupported()` 并实际 `show()`。

运行：

```powershell
$env:M4_S3_OUT="$PWD\spikes\m4\s3-result.json"
& ".\apps\desktop\node_modules\.bin\electron.CMD" ".\spikes\m4\src\s3-notification.mjs"
Get-Content .\spikes\m4\s3-result.json
```

### 5.3 结果（2026-11-08，Windows）

```json
{
  "platform": "win32",
  "supported": true,
  "focused": false,
  "visible": false,
  "shouldNotify": true,
  "events": ["show"],
  "error": null
}
```

- `Notification.isSupported()` 为 true，隐藏窗口未被判定为前台，`show` 事件触发。
- 载荷只包含 `Cairn · <Agent>` 与 `<会话标题>：<动作>`；策略测试断言不含 API Key、消息正文或用户路径。
- 发送条件：前台且可见时不通知；禁用时不通知；同一会话 15 秒内不重复通知；窗口不可见但有焦点（最小化到托盘）时仍通知。

### 5.4 结论

**go。** M4-06 采用主进程聚合 + 通知。必须在真实桌面上补验：

- 系统勿扰 / 专注助手是否会抑制通知；
- 点击通知是否回到对应会话并聚焦窗口；
- 多显示器与通知中心的历史行为。

这些属于 `[用户本地]` 验收项，不能由 CI 代替。

## 6. S4 后台命令

### 6.1 假设

现有 `@cairn/shell` 的进程树机制在应用退出时能结束命令启动的整个进程树；取消命令不会留下孤儿进程。

### 6.2 方法

`spikes/m4/src/s4-background-command.test.ts`：

1. 直接创建 `ProcessTree`，启动一个持续运行的 Node 子进程并 `attach`，然后 `dispose()`（等价于应用退出时关闭作业句柄），检查子进程退出。
2. 用 `runCommand` 启动一个写入 PID 文件后持续运行的进程，在运行中 `abort`，检查结果 `aborted` 且 PID 不再存活。

### 6.3 结果（2026-11-08，Windows）

```text
M4_S4_RESULT {"platform":"win32","mechanism":"job-object"}
```

- `dispose()` 后子进程立即退出。
- 取消命令后，`runCommand` 返回 `aborted: true`，PID 在轮询窗口内消失。
- Windows 使用 Job Object；其他平台使用进程组，测试在 Ubuntu workflow 中运行。

### 6.4 结论

**go，但 M4-14 仍为可选。** 清理原语可靠；后台命令服务必须：

- 让命令的生命周期长于一次工具调用；
- 在应用退出、宿主崩溃或服务停止时关闭作业 / 进程组；
- 自己保存 PID、退出码与输出缓冲，不能依赖 `runCommand` 的“结束即清理”。

如果 M4-14 排期不足，按计划移出 M4，不影响完成标准。

## 7. 复现

```powershell
pnpm spike:m4
pnpm vitest run --config spikes/m4/vitest.config.mts src/s1-multi-run.test.ts --reporter=verbose
pnpm vitest run --config spikes/m4/vitest.config.mts src/s2-worktree.test.ts --reporter=verbose
```

CI：`.github/workflows/spike-m4.yml` 在 `windows-latest` 与 `ubuntu-latest` 上运行同一组测试（S3 的 Electron 探针只在本地/真实桌面运行）。

## 8. 剩余风险

| 风险 | 处理 |
|---|---|
| 同一宿主多运行的内存与 CPU 在真实模型下更高 | M4-13 用 3 会话 × 2 子运行压测；必要时限制每会话运行数与工具并发 |
| Windows worktree 在非 NTFS / 网络盘 / 权限异常时失败 | M4-08 捕获失败并回退到导出式工作区；界面提示 |
| 通知在勿扰模式下静默 | 活动中心侧栏角标仍是权威提示；通知只作为增强 |
| 后台命令留下孤儿进程 | M4-14 复用 Job Object / 进程组，启动前记录 PID，退出时统一关闭 |
