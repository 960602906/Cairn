# 目标条 Cursor 化重设计

> 状态：待实现。上级：ADR-0047、[goal-mode.md](../../plan/goal-mode.md)。  
> 范围：输入框上方目标条交互与外观；新增条件更新协议；侧栏面板对齐。  
> 不改：判定器、预算默认值、权限、自动续轮语义。

## 1. 问题

当前 `GoalBar` 虽已浮在输入框上方，但做成了两行信息卡（条件 + 长状态 + 带文字按钮），清除只在侧栏，条件创建后不能改。用户期望接近 Cursor：贴着输入框的单行细条，可暂停、改条件、删除。

## 2. 目标条（UI）

### 2.1 布局

与待办进度条（`TaskProgress`）同一套细卡：Composer 正上方、`mb-2 rounded-card bg-raise shadow-2`、单行 `h-9`。

```
[图标]  条件（单行省略）     短状态   [暂停|继续] [改条件] [删除]
```

- 状态图标：活动用 Target（运行中可轻微 pulse，尊重 `prefers-reduced-motion`）；暂停用 Pause。
- 条件：点击仍打开目标侧栏；编辑态除外。
- 短状态：仅 `进行中` / `判定中` / `准备继续` / `等待审批` / `等待回答` / `已暂停` / `本轮结束后暂停` 一类短词；详细暂停原因放在 `title` 与侧栏。
- **不在条上显示**轮次（第 N/M）、活动时长。预算只在 `GoalPanel`。
- 操作：图标按钮——暂停 / 继续、改条件（✎）、删除（🗑）。去掉条上「打开面板」的 Target 按钮（点条件即可）。
- 继续仍在会话 busy（running / waiting_approval / waiting_input）时禁用。
- 删除：确认对话框后调用现有 `goal.clear`；与面板清除同一路径。
- 失败提示：条内短文案，不静默吞掉。
- **不要**嵌进 Composer 卡片内部，也不要做成两行信息卡。

### 2.2 改条件（条内）

1. 点 ✎ 进入编辑：条件区变为 input，预填当前条件。
2. Enter 保存；Esc 取消；失焦时有改动则保存、无改动则退出编辑。
3. 空串或超长（`GOAL_CONDITION_MAX`）：保持编辑并提示，不写事件。与原文相同：退出编辑、不写事件。
4. `active` 与 `paused` 都可改；已结束目标无条、不可改。
5. 不中断当前轮；新条件从下一轮系统提示词注入与下一次判定起生效。

`GoalPanel` 提供同一「改条件」动作（调用同一 store/IPC），避免只能在条上改。

## 3. 协议与投影

### 3.1 事件

新增持久事件：

```ts
'goal.condition_updated': {
  goalId: Id
  condition: string // trim 后 1…GOAL_CONDITION_MAX
}
```

只对未结束目标（`active` | `paused`）生效。已结束或不存在 → 不写事件，IPC 返回 `goal.not_found`。

### 3.2 IPC

```ts
'goal.updateCondition': {
  params: { sessionId: Id, condition: string }
  result: {}
}
```

- 有未结束目标即可；**不要求会话空闲**（与 pause/clear 一致）。
- 校验 trim、长度；与当前条件相同 → 无操作成功（不写事件）。
- 错误码：`goal.not_found`；参数非法走现有校验错误。

### 3.3 投影

`SessionView` 中未结束目标的 `condition` 在收到 `goal.condition_updated` 后替换。回退按 seq 过滤后重放，与其它目标事件一致。

### 3.4 判定与宿主

- 判定调用开始时快照当时的 `condition`；进行中用户改条件，本次判定仍按快照结案。
- 宿主侧：下一轮 `host.prompt` 的 `goal.condition` 取投影最新值；当前已开始的一轮不重写系统提示词。
- `/goal` 子命令本轮**不**新增 `update`（可用条 / 面板；YAGNI）。

## 4. Store / 接线

- renderer store 增加 `updateGoalCondition(sessionId, condition)` → IPC。
- preload / gateway 暴露对应方法。
- `GoalBar` / `GoalPanel` 共用该 action。

## 5. i18n

中英 `session` 命名空间：

- 条上短状态键（可复用或收紧现有 `goal.bar.*`，去掉条上对轮次/时长的依赖）。
- `goal.bar.edit` / `goal.bar.delete` / 删除确认文案。
- 条件更新失败提示（接入 `goalErrorNoticeKey` 或等价）。

`goal-i18n.test.ts` 覆盖新键。

## 6. 测试

| 层 | 覆盖 |
|---|---|
| 投影 | `condition_updated` 更新未结束目标；结束后忽略；回退重放 |
| GoalService / IPC | 更新成功、相同无事件、无目标 `not_found`、长度边界 |
| GoalBar | 单行三按钮；编辑保存/取消；删除确认；busy 时继续禁用；无轮次/时长文案 |
| GoalPanel | 可改条件 |
| e2e | 条上清除；改条件后面条文案更新 |

## 7. 文档

- 更新 [goal-mode.md](../../plan/goal-mode.md) §9.2：细条布局；清除可上条（确认后）；条上不展示预算；条件可更新。
- ADR-0047 补一句：条件可通过 `goal.condition_updated` 修改（非新建）。
- CHANGELOG 记一条用户可见变更。

## 8. 非目标

- 条上编辑轮次/时长预算。
- 悬停才显示删除。
- 改条件后中止或重跑当前轮。
- 多目标、跨会话目标、无人值守目标循环。

## 9. 验收

- 有未结束目标时，输入框上方为单行细条，可见暂停/继续、改条件、删除。
- 条上无「第 N/M 轮」与活动时长。
- 改条件后条与面板文案更新；当前轮不中断；后续续轮/判定使用新条件。
- 删除经确认后目标结束，条消失。
- 浅色/深色、窄宽度、减少动态效果下不遮挡输入框与审批卡。
