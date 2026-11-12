# 聊天区域状态显示优化方案

> 状态：已实施（2026-11-12）。按确认意见，**不恢复输入框上方的可见运行状态条**；现有的 `sr-only` 读屏状态保留。
> 实现：`status-presentation.ts`（状态 / 结局 / 色调映射）、`MessageStream.tsx`（空会话引导、思考中占位、结局分级卡片）、
> `SessionHome.tsx` / `SessionList.tsx`（图形 + 文字，同一套色调）；e2e 见 `visual.spec.ts` 的
> “chat status reads the same in both themes without a status bar”。
> 上级文档：[视觉规范](../design/visual-style.md)（ADR-0024）、[M2 计划](m2.md) M2-04、[M4 计划](m4.md) M4-05。
> 适用：桌面应用 `apps/desktop/src/renderer` 中间对话列内的状态反馈，不含输入框上方新增状态条。
>
> 第二轮（2026-11-12，按用户反馈）：见文末「6. 第二轮调整」。要点是消息列内**新增**可见的运行指示
> （不是输入框上方的状态条），工具步骤改用彩色品牌图形（运行中旋转 / 成功绿色 / 失败红色），去掉工具竖线与轮次之间的检查点分隔线。

## 1. 目标与范围

把聊天区域从「空闲 → 运行中（思考 / 调用工具 / 等待审批 / 停止中）→ 结束（完成 / 停止 / 中断 / 失败 / 重试 / 限额 / 崩溃）」以及「空会话、流式生成中、审批、工具步骤」等状态，做成清晰、一致、可访问的显示；保持对话区克制，不在输入框上方新增常驻或浮起的状态条。

范围包含：轮次结局、重试与限额、空会话、生成中占位、等待审批提示、工具步骤，以及右侧工作台首页的状态文字。

### 1.1 不在范围内

- **输入框上方新增可见运行状态条**（转圈、状态文字、已用时间、`按 Esc 停止`、步骤 / token、接近限额警告、检查器入口）：按 2026-11-12 确认意见不做。`ChatPanel.tsx` 现有的 `sr-only` `role="status"` 保留，只优化播报文案与时机；`PlanProgress`（`PlanCard.tsx`）与 composer 之间的布局保持现状。
- 后端、事件协议、会话归约与侧栏会话列表的交互逻辑。
- 新增设计令牌、UI 基础组件库或第三方依赖；一律复用现有令牌、`Spinner`、`Shimmer`、Lucide 图标。
- 状态数值的持久化与跨会话聚合（活动中心、检查器数据）。

### 1.2 范围决定

- 2026-11-12：确认不恢复输入框上方的可见运行状态条。视觉规范 §6 与 M2-04 / M4-05 中「运行状态条」的描述不再作为本次交付项；本次只统一对话列内**已有**状态的视觉分级，并补齐空会话、生成中占位等缺失反馈。
- 若后续要重开状态条，需另立任务并重新评估与 `PlanProgress`、贴底滚动、审批卡片可见性的冲突。

## 2. 现状（代码依据）

- `ChatPanel.tsx:323-326`：只有一个 `sr-only` 的 `role="status"`，注释明确写「视觉上不占位」。本次保留这一形态，不新增可见状态条。
- 视觉规范 §6 与 M2-04（`m2.md:130-135`）、M4-05（`m4.md:290-306`）描述的「运行状态条」在 `Composer.tsx` 中并不存在（只有「发送 / 停止」按钮）；`run.tooling` / `run.aborting` 等文案也从未被使用。**这一项按 1.2 明确不做**，仅作为背景记录。
- `MessageStream.tsx:871-887`：轮次结局（停止、中断、失败、限额、重试、崩溃）统一是一行灰色文字加可选「继续」按钮，没有图标或严重程度区分，不符合规范「状态不只靠颜色」。
- `MessageStream.tsx:570-611`：`LiveMessage` 在刚发送、还没有思考或正文时渲染一个空的 `<li aria-busy>`，界面完全空白；只有 reasoning 出现才有 Shimmer。
- `MessageStream.tsx:773-775`：`view === undefined` 时返回空 `<ol>`，聊天区没有空状态引导（规范 §9 要求空会话显示品牌图形）。
- 状态色调分散：`SessionList.tsx:76-87` 用圆点加 Spinner，`SessionHome.tsx:24-29` 只用文字色，`ToolTimeline.tsx:132-166` 用节点图标，`ChatPanel` 只有读屏文字，缺少统一映射。

> 计划模式是只读的，当时未能运行 `impeccable context` 启动器；本方案以仓库内既有规范、ADR 与现有实现为依据。实施阶段按 `impeccable` 的 polish / harden 检查（a11y、i18n、边界态），并实际核对浅色 / 深色渲染结果。

## 3. 实施步骤

1. **状态清单与范围基线**：把轮次结局、重试 / 限额、空会话、生成中、审批、工具步骤逐项映射到目标呈现；确认本次不新增状态条，`PlanProgress` 与 composer 之间的区域保持现状。
2. **统一状态 tone / 图标映射**：抽一个小模块或同文件常量，把 neutral / warn / danger 与 idle / running / thinking / tooling / waiting_approval / aborting 映射到 `accent`、`ok`、`warn`、`danger` 及其 `-soft` 底、`Spinner`、`Shimmer` 与 Lucide 图标；一律「图标 + 文字」，不靠颜色单独表意。映射只服务于对话列内的状态，不驱动任何新的状态条。
3. **保留并收敛读屏状态**：`ChatPanel` 的 `sr-only` `role="status"` 继续作为唯一状态播报点，只调整播报文案与时机（状态变化才播报，不加入计时）；不新增 `RunStatusBar.tsx`，不改 `Composer` 的输入框上方布局；`Esc` 停止与审批卡片数字键的现有逻辑不变。
4. **轮次结局分级**：停止 / 中断用中性、重试与限额用 `warn`、失败与崩溃用 `danger`，配图标与浅底卡片；保留「继续」按钮和现有文案；`message.incomplete` 与重试倒计时并入同一分级。
5. **空状态与「生成中」占位**：无消息时用 `CairnMark` 加一句提示（参考 `PanelEmpty` 的克制样式）；`LiveMessage` 在无思考且无正文时显示带 Shimmer 的「思考中」占位（复用 `run.thinking`），不再出现空白 `<li>`；等待审批时由审批卡片本身给出醒目提示，并在 `sr-only` 状态里播报。
6. **周边状态对齐**：审批卡片的等待态、工具时间线节点 / 状态文字（基本已符合规范，只做 tone 对齐）、右侧工作台首页 `SessionHome` 的 `status` 改为「圆点 / 图标 + 文字」，与 `SessionList.StatusMark` 的色调一致。
7. **文案与 i18n**：不新增状态条相关文案；生成中占位复用 `run.thinking`，结局图标的无障碍标签与空状态提示等新增 key 同步写入 `zh-CN/session.json` 与 `en-US/session.json`，通过 `pnpm check:i18n`。
8. **测试与验证**：新增 / 更新 `ChatPanel.test.tsx`、`MessageStream.test.tsx` 等用例，覆盖空状态、生成中占位、结局分级、aria 播报、`Esc` 与审批卡片快捷键不冲突，并断言输入框上方没有新增状态条 / 计时 / 停止提示（防止后续回归）；`visual.spec.ts` 补浅色 / 深色截图；按第 5 节执行全量检查。

## 4. 风险

- 不新增状态条后，状态判断只用于结局 / 占位 / 审批，仍需覆盖「已发送但轮次未开始（`awaitingTurn`）」「等待审批」「正在停止」「子运行 / 委派」等边界，避免误显示。
- 现有大量单测 / e2e 断言 `[role="status"]` 与固定文案，改动易回归 → 同步更新断言并保留读屏语义。
- 新增 i18n key 必须中英完全一致；动态 key `t('status.${status}')` 的取值集合不要漏配。
- 空状态与生成中占位会改变消息流的高度，需确认与贴底滚动（`stick-to-bottom.ts`）、审批卡片完整可见性不冲突。
- 若实际诉求只是局部微调，需按确认意见继续收缩范围，避免过度改动。

## 5. 验证

- 命令：`pnpm typecheck`、`pnpm lint`、`pnpm test`（重点相关用例）、`pnpm format:check`、`pnpm check:i18n`、`pnpm --filter @cairn/desktop e2e` 中 `visual.spec.ts` / `conversation.spec.ts` / `approval.spec.ts` 不回归。
- 渲染核对（浅色 / 深色、窄窗口）：空闲空状态、发送后未出字、思考中、等待审批、停止 / 中断 / 失败 / 崩溃 / 限额 / 重试各状态的图标 + 文字 + 颜色 + 读屏播报；**输入框上方布局与现状一致，没有新增状态条、计时或停止提示**；空状态与生成中占位出现时不抖动、不遮挡审批卡片；键盘 `Esc` 与审批数字键不冲突；减少动态效果时动画关闭。

## 6. 第二轮调整（2026-11-12）

按用户反馈收尾，仍不新增输入框上方状态条：

1. **运行指示（消息列内）**：发送后到第一条正文 / 思考增量之间不再空白。`status-presentation.ts` 的 `runningActivityKey(view, awaiting)` 给出「当前阶段」文案（运行中 / 思考中 / 正在调用工具 / 正在停止 / 等待审批 / 等待子任务回落到运行中）；`RunningIndicator.tsx` 用旋转的环石 C + 流光文字显示。只在空白期出现：已有流式正文 / 思考、已有正在执行的顶层工具、或已有轮次结局提示时不显示。放在消息 `<ol>` 之外，避免影响消息计数与流式文本采集的 e2e 断言。
2. **工具步骤**：`ToolTimeline.tsx` 的节点改用环石 C（执行中旋转，成功绿色，失败红色），取消 ✓/✕ 和纵向连接线；语义仍靠状态文字和颜色区分；`SUMMARY_KEYS` 增加 `name`，`load_skill` 只显示技能名（无「加载」字样、无原始 JSON、无等宽底块）；`start_command` 补上「后台运行」动作词。
3. **去掉检查点分隔线**：删除 `Checkpoints.tsx` 的 `CheckpointDivider` 与 `MessageStream` 的 `divider` 传参，及 `checkpoint.divider` 文案。「撤销本轮」、`TurnRail` 导航条与恢复标记保留。
4. **计划进度**：`PlanCard.tsx` 的 `StepIcon` 与工具步骤视觉一致：进行中旋转的品牌图形、完成绿色品牌图形；未开始和跳过仍用各自形状。`PlanStepStatus` 目前只有 `pending/in_progress/done/skipped`，没有失败态，不伪造红色失败步骤；轮次失败仍由结局卡片提示。
5. **测试与视觉**：`status-presentation.test.ts`、`MessageStream.test.tsx`、`ToolTimeline.test.tsx`、`PlanCard.test.tsx`、`ChatPanel.test.tsx` 同步更新；本地 e2e 截图核对运行指示与工具完成态（绿色品牌图形、技能名摘要、无竖线）。
