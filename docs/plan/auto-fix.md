# 自动修复（Auto-fix）设计草案

> 目标：把「PR 的 CI 失败、合并冲突、新评审意见出现时，自动开一个 Agent 会话去修、验证、
> 提交并推送」做成 Cairn 的内置能力。
> 状态：M8-01～M8-05 已实现；自动推送的边界与守卫见 [ADR-0045](../adr/0045-auto-fix-push-boundary.md)。

## 1. 与 Claude Code Auto-fix 的对应关系

| 外部能力 | Cairn 里的对应物 |
|---|---|
| 监视 PR 的 CI / 冲突 / 评审意见 | 主进程里的轮询型 watcher（本机发起，无需公网入口） |
| 出问题时唤醒会话 | 以 `auto-fix` 种类创建会话，起一次**无人值守运行**（ADR-0018） |
| Agent 改代码、跑测试 | 复用现有运行、工具流水线、检查点与权限引擎 |
| 提交、推送 | 新增可审计的 `git_commit` / `git_push` 工具，只在自动修复会话里放行 |
| 关注/修复状态展示 | 活动中心（ADR-0032）+ 会话列表标记 |
| 不自动合并、不强制推送 | 权限守卫 + 分支守卫硬性拒绝 |

## 2. 总体结构

```
GitHub REST ──► github-service (主进程)
                     │  快照、检查项、失败日志、评审意见
                     ▼
              auto-fix-service (主进程)
                     │  计算「需要注意」+ 去重签名
                     │  超过次数 → 记录并通知，不再触发
                     ▼
              session-manager：创建 kind=auto-fix 会话 → prompt（unattended）
                     │
                     ▼
              agent-host：新工具 pr_* / git_commit / git_push
                     │  改代码、跑测试、提交、推送
                     ▼
              回写 job 状态 → 下一轮轮询重新评估 → 通过或放弃
```

所有选择都遵循「本地优先」：不需要服务器、不需要公网回调；网络出站只有 GitHub REST。

## 3. 关键设计决策

### 3.1 用轮询而不是 Webhook

桌面应用没有稳定的公网入口；Webhook 需要托管服务，与本地优先冲突。
因此由主进程按 PR 轮询，使用 `ETag` / `If-None-Match` 条件请求，读取
`x-ratelimit-remaining` 与 `x-ratelimit-reset` 做退避。默认每个 PR 60 秒，加抖动；
同时监视的 PR 数量设上限（建议 20）。

### 3.2 认证与凭据

使用 GitHub fine-grained PAT，作用域最小化：`Contents: write`（推送）、`Pull requests: read/write`
（读状态、可选回复评论）、`Checks: read`（检查项日志）。令牌自动解析，不设界面配置：
先读环境变量 `GH_TOKEN` / `GITHUB_TOKEN`，再读旧版设置页保存的凭据（兼容升级），最后调用本机
`gh auth token`。令牌绝不写入日志、事件或诊断包。Cairn 不捆绑 `gh`；只要能提交并创建 PR 的
环境，自动修复就能直接工作。

### 3.3 修复在哪里执行

不复用用户当前工作目录（可能停在别的分支、有未提交改动）。为每个被监视的 PR 建一个
**独立 worktree**（挂在 `userData/worktrees/pr-<watchId>`，复用 `workspace-service` 与
`@cairn/checkpoint` 的 git 调用）：

1. 每次修复前 `git fetch origin`，把工作区重置到 `origin/<headBranch>`；
2. Agent 在 worktree 里改代码、跑项目检查；
3. 提交后推送到同一分支；
4. 保留 worktree 供下一轮复用，删除 watch 时清理。

这与隔离工作区（ADR-0031）是同一套机制，只是生命周期从「一次委派」延长到「一个被监视的 PR」。

### 3.4 触发条件与去重

「需要注意」= 以下任一：

- 有 `status: completed` 且 `conclusion` 为 `failure` / `cancelled` / `timed_out` 的检查项；
- `mergeable_state === 'dirty'`（合并冲突）；
- 自上次修复后出现新的评审意见（按评论 id 取最大值）。

去重签名：

```
ci        → headSha + ':' + sorted(失败检查名)
conflict  → headSha
comment   → headSha + ':' + lastCommentId
```

签名与上一次相同就跳过；修复推送后 `headSha` 变化，自然进入下一轮评估。
每个 watch 记录 `attempts`，达到 `maxAttempts`（默认 3）后停止并通知，等待人工介入。

### 3.5 安全边界（硬性）

自动修复会写代码并推送，必须默认收窄：

- **只推当前 PR 的 head 分支**：`git_push` 校验当前分支、远端与 PR 的 head 一致；
- **禁止 `--force` / `--force-with-lease`**：合并冲突用 `git merge origin/<base>` 解决，
  不用 rebase 改写已推送历史；确需改写时由用户在界面显式操作；
- **禁止合并、禁止改保护分支、禁止推送其他分支**；
- **权限只放行这个 worktree 内**的读写与 `git_commit` / `git_push`，其余工具按默认拒绝；
- 运行设短预算（轮次、token、时长），避免反复尝试消耗用量；
- **总开关**：暂停全部监听，立即停止排队中的 job 并中止正在运行的自动修复会话；
- 诊断包、事件、日志里不出现令牌；`run_command` 的环境不带令牌，推送走 `git_push` 工具内部的
  受控凭据注入。

### 3.6 会话可见性

采用「可见但带标记」：自动修复会话出现在会话列表里，带 `auto-fix` 标记（类似试运行的 `kind`），
可以从「活动中心」与设置页直接跳到对应会话；默认不参与标题/自动摘要的重复生成。
不学试运行那样完全隐藏——用户需要看到 Agent 改了什么、为什么放弃。

## 4. 分层实现

### 4.1 协议（`packages/protocol/src/github.ts`）

新增 zod 契约：

- `GithubStatus`：`{ connected, login?, scopes? }`
- `GithubPullRequest`：`number, title, headRef, headSha, baseRef, state, mergeableState, checks: CheckRun[]`
- `CheckRun`：`name, status, conclusion?, detailsUrl?, startedAt?, completedAt?`
- `PullRequestWatch`：`watchId, repo, prNumber, projectPath, agentId?, triggers, maxAttempts, enabled, attempts`
- IPC：`github.status`、`github.connect`、`github.disconnect`、`github.pulls`、
  `github.watch.list|create|update|remove`、`github.watch.pauseAll|resumeAll`
- 事件：`github.watch.changed`、`autofix.job.changed`

### 4.2 主进程服务

- **`github-service.ts`**：REST 客户端（`fetch` + ETag 缓存 + 速率限制退避）。只读方法：
  `prSnapshot(repo, number)`、`checkRuns(repo, sha)`、`checkLog(repo, runId)`、
  `reviewComments(repo, number)`；写方法：`comment(repo, number, body)`（可选）。
  令牌经凭据存储读取，错误分类成协议错误码。
- **`auto-fix-service.ts`**：watcher 与 job 调度。
  - 持有 watch 配置（持久化），定时器按 watch 轮询；
  - 计算签名、去重、尝试次数；
  - 需要修复时调用 `sessions.create` + `sessions.prompt`（`mode: unattended`），
    把失败检查、日志尾部、冲突文件、新评论写进 brief；
  - 每 PR 串行、全局并发上限（建议 2），排队；
  - 订阅会话事件，写回 job 状态（running / pushed / passed / gave_up）。

### 4.3 Agent 工具

在 `agent-host` 注册，仅对自动修复 Agent 开放（按 `toolSelected` 与 agent 定义）：

| 工具 | 作用 | 守卫 |
|---|---|---|
| `pr_snapshot` | 读 PR 状态、检查项、冲突文件 | 只读 |
| `pr_check_log` | 读失败检查的日志尾部（截断） | 只读，长度上限 |
| `pr_review_comments` | 读自上次修复后的新评审意见 | 只读 |
| `git_commit` | 在 worktree 提交 | 仅 auto-fix 会话，禁止 amend 已推送提交 |
| `git_push` | 推送到 PR head 分支 | 校验分支/远端；拒绝 force；返回新 SHA |
| `pr_comment` | 回复评审意见（可选，默认关闭） | 需显式开启 |

`git_push` 的推送凭据只在工具内部注入，不进入 `run_command` 环境与日志。
M8-04 只实现评审意见的读取与触发；可选的 `pr_comment` 回复在后续阶段接入。

### 4.4 存储（迁移 0022）

```sql
CREATE TABLE pull_request_watches (
  watch_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,                -- owner/name
  pr_number INTEGER NOT NULL,
  project_path TEXT NOT NULL,
  agent_id TEXT,
  triggers TEXT NOT NULL,            -- JSON {ci, conflict, comment}
  max_attempts INTEGER NOT NULL DEFAULT 3,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_signature TEXT,
  last_evaluated_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (repo, pr_number)
);

CREATE TABLE auto_fix_jobs (
  job_id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  trigger TEXT NOT NULL,             -- ci | conflict | comment
  signature TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued|running|pushed|passed|gave_up|cancelled
  attempt INTEGER NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (watch_id) REFERENCES pull_request_watches (watch_id) ON DELETE CASCADE
);
CREATE INDEX auto_fix_jobs_by_watch ON auto_fix_jobs (watch_id, created_at DESC);
```

会话表沿用 `0014-session-kind` 的 `kind`，新增取值 `auto-fix`，无需改表结构。

### 4.5 界面

- **不设设置分类**：GitHub 令牌自动解析，设置页没有「自动修复」入口。
- **会话内开启**：Agent 提交并创建 PR 后，先问用户是否开启自动修复；同意后调用
  `watch_pull_request`（调用本身仍走审批）。监视使用会话的项目目录。
- **活动中心**：每个 job 一条状态（排队 / 修复中 / 已推送 / 通过 / 放弃），可跳到会话；
  每条监视都可以就地停止。
- **会话**：`auto-fix` 标记；顶部固定一条触发上下文（PR、失败检查、冲突文件）。
- 完成或放弃时走现有活动通知（`activity-notifier`）。

### 4.6 i18n

新增 `packages/i18n/locales/{zh-CN,en-US}/settings.json`（及 `session.json`）条目，
`pnpm check:i18n` 保持一致。

## 5. 一次修复的完整流程

1. watcher 轮询到 `ci` 失败，签名与上次不同，`attempts < maxAttempts`；
2. 建 job（queued），创建 worktree，`git fetch` + 重置到 `origin/<head>`；
3. 创建 `auto-fix` 会话，无人值守 prompt，brief 带上失败检查名与日志尾部；
4. Agent 读日志、改代码、跑项目检查；失败就重试（受运行预算约束）；
5. `git_commit` + `git_push` → job 记为 `pushed`，`attempts++`；
6. 下一轮轮询：若检查变为 success → `passed`；若仍失败且签名变化 → 进入下一次（回到 2）；
   若达到上限 → `gave_up` 并通知；
7. 用户随时可以在设置页暂停、或在会话里停止运行。

## 6. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| M8-01 GitHub 连接与只读 | 令牌、仓库/PR 读取、快照与检查项、只读工具 | 在应用里看到 PR 的 CI 状态与失败日志 |
| M8-02 监视与触发 | watcher、去重、无人值守会话、活动条目；**不推送** | CI 失败后自动开一个会话，Agent 在 worktree 里给出修复但需人工推送 |
| M8-03 自动推送闭环 | `git_commit`/`git_push` + 分支守卫、尝试上限、回检、通知 | 失败检查 → 修复推送 → 回检通过；超限后停止并通知 |
| M8-04 冲突与评审意见 | 冲突合并、评审意见读取、可选回复 | 冲突 PR 自动合并 base 并修复；新意见可触发一轮 |
| M8-05 打磨 | 界面、i18n、文档、e2e、暂停/恢复 | 设置页与活动中心完整，端到端用例通过 |

每个阶段都应能独立合并、独立回退；M8-01/M8-02 不推送，风险最低，建议先做。

## 7. 测试策略

- **单元**：签名计算、去重、退避与速率限制、分支守卫（拒绝 force / 错误分支）、
  attempt 上限。
- **集成**：本地假 GitHub（HTTP 桩）覆盖快照、检查项、评论；断言失败 → 创建 job → 会话。
- **工具**：`git_push` 在本地裸仓库上推送成功；拒绝 `--force`、拒绝非 PR 分支。
- **e2e**：假 GitHub + 一个失败检查，假模型完成一次改动 → 推送 → 检查转绿；再断言达到上限后放弃。
  已落地的用例（`apps/desktop/e2e/autofix.spec.ts`）覆盖令牌静默解析（`GH_TOKEN`）、会话开启监视、
  自动开修复会话、活动中心列表与跳转、停止监视；真实的推送链路由单元测试覆盖（本地假远端无法验证
  `git_push` 硬编码的 GitHub 目标）。假 GitHub 由 `CAIRN_GITHUB_API_URL` 指向本机回环地址，只在
  开发构建里生效，且只接受 HTTPS 或回环 HTTP，避免把令牌发到别处。
- 覆盖率维持现有 ≥ 95% 门槛。

## 8. 待决问题（后续阶段）

> 推送边界已由 ADR-0045 决定；以下问题在 M8-04/M8-05 落地前仍需决定。

1. 轮询的网络与隐私边界：出站域名、令牌权限、是否允许企业版 GitHub / 自建实例。
2. `auto-fix` 会话是否默认可见；与用量统计、标题生成、记忆的交互。
3. GitHub 工具用内置工具还是内置 MCP server（复用 ADR-0026 的通道，便于以后扩展）。
4. ~~冲突修复用 merge 还是 rebase；是否允许 `--force-with-lease`~~：已决定用 merge，不改写已推送
   历史，也不允许 force / force-with-lease（ADR-0045、M8-04）。
5. 多账号 / 组织仓库支持的范围。