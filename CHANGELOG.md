# Changelog

本文件记录 Cairn 的用户可见变化，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 团队模板版本历史：编辑器下方列出每次发布的版本（时间、协作模式与成员数），可以与当前草稿
  逐字段对比；确认后把旧版本恢复为草稿，继续编辑并发布后成为新版本，不会改写历史。
  Team template version history: the editor lists every published version with its time,
  collaboration pattern and member count. Any version can be compared field by field with the
  current draft, then restored as the draft after confirmation; publishing it creates a new
  version without rewriting history.

- 团队模板：设置里新增「团队模板」页，可新建、搜索并按状态筛选；编辑器配置中英文名称与描述、
  主控与成员，以及协作模式（自由委派 / 审查循环 / 流水线）。流水线阶段只能依赖排在它前面的
  阶段，审查循环会自动保证 maker / checker 在成员里；保存草稿与发布前实时校验，问题直接标在
  对应的分区。编辑器里可以用当前草稿直接试运行，草稿改动后提示重新开始，试运行历史可清除。
  Team templates get a Settings page with search and status filters, plus an editor for
  bilingual names and descriptions, coordinator and members, and collaboration patterns
  (delegate, review loop, pipeline). Pipeline stages can only depend on earlier stages, and
  review loops keep maker and checker inside the team. Validation runs while editing and
  before publishing, with issues attached to their section. A team can be trialled from the
  editor with the current draft; changes prompt a restart, and trial history can be cleared.

- 输入框支持从操作系统（Finder / 资源管理器）拖入或粘贴文件与文件夹：会转成工作空间内的 `@` 引用，
  一次可多个；工作空间外的文件会提示并忽略，未选择工作空间时先提示。拖动时输入框显示“松开以引用文件”。
  The composer accepts files and folders dragged from Finder or Explorer, or pasted after copying:
  they become workspace-relative `@` references (multiple at once). Files outside the workspace are
  ignored with a hint, and a hint appears when no workspace is selected. A "release to reference
  files" overlay shows while dragging.

- 搜索对话（⌘K）现在也会搜索消息正文：标题或项目名不匹配的会话，只要消息里出现输入的词，
  也会带着命中附近的片段出现在结果里；输入停顿后才查询，切换输入不会显示上一次的片段。
  Search conversations (⌘K) now searches message text too: a session whose title or project does
  not match still appears when the words occur in its messages, with a snippet around the hit.
  Queries run after a short pause, and stale snippets never appear for a new query.

- 会话导出：会话操作菜单可以把整段对话复制为 Markdown，或导出为 `.md` 文件（系统另存对话框）。
  导出包含用户与助手的正文、图片占位与工具调用名称，不包含推理与工具输出。
  Export a chat as Markdown from the session menu: copy the whole conversation or save a `.md`
  file through the system save dialog. The export includes user and assistant text, image
  placeholders and tool call names, but not reasoning or tool output.

- 会话内查找：⌘F（Windows / Linux 为 Ctrl+F）在对话正文里查找，显示当前第几处与总数，
  Enter / Shift+Enter 或按钮跳到下一处 / 上一处，Esc 关闭；高亮覆盖 Markdown、代码与工具输出。
  Find in conversation: ⌘F (Ctrl+F on Windows and Linux) searches the rendered chat, shows the
  current match and total, steps with Enter / Shift+Enter or the arrow buttons, and closes with
  Escape. Highlights cover Markdown, code and tool output.

- 新增一组桌面快捷键：⌘L 聚焦输入框、⌘B 收起或展开侧栏、⌘J 收起或展开工作台、⌘⇧[ / ⌘⇧]
  切换上一个或下一个会话，以及 ⌘+ / ⌘- / ⌘0 缩放界面；Windows / Linux 使用 Ctrl。帮助面板同步列出。
  Adds desktop shortcuts: ⌘L focuses the composer, ⌘B toggles the sidebar, ⌘J toggles the
  workbench, ⌘⇧[ / ⌘⇧] switch to the previous or next session, and ⌘+ / ⌘- / ⌘0 zoom the
  interface, with Ctrl on Windows and Linux. The help panel lists them too.

- 窗口会记住大小、位置、最大化状态与缩放比例，下次启动时恢复；显示器变化后不会恢复到屏幕外。
  The window remembers its size, position, maximized state and zoom level across launches, and
  never reopens fully off-screen after displays change.

- 会话可以置顶：在会话操作菜单里选择「置顶」，置顶的会话排在列表最前，且不会因为置顶改变最近
  更新时间；归档的会话不显示置顶操作。
  Sessions can be pinned from the session menu and sort to the top without changing their updated
  time; archived sessions do not offer pinning.

- 在 Windows / Linux 上，有会话正在运行时关闭窗口会先确认，避免误关中断回复。
  On Windows and Linux, closing the window while chats are running asks for confirmation first.

- 新对话页可以选择 Agent：输入框左下新增 Agent 选择器，选中的 Agent 在创建会话时生效，并按工作
  空间记住上次的选择；菜单底部「管理 Agents」直达设置。
  The new-chat composer gains an agent picker: the chosen agent applies when the session is created
  and is remembered per workspace. "Manage agents" at the bottom opens Settings.

### Changed

- 会话输入框的 Agent 选择器按内置在前、自定义在后排列，每项显示一行描述并支持搜索；当前 Agent
  归档后仍显示名称并在菜单中标记「已归档」，运行中禁用时提示「运行结束后可切换」。
  The session composer's agent picker lists built-in agents before custom ones, shows a description
  for each, and supports search. An archived current agent keeps its name and is marked "Archived";
  while running, the picker says you can switch after the run ends.

## [0.1.6] - 2026-11-26

### Added

- 权限模式新增“完全访问”：不再询问，危险命令、敏感文件与沙箱不可用时的拦截也会跳过；计划模式仍然
  只读，沙箱档位与你手动添加的拒绝规则仍然生效。输入框、设置页与 Agent 权限都可以选择（ADR-0048）。
  Adds a Full access permission mode that never asks, including for dangerous commands, sensitive
  files and sandbox-unavailable cases. Plan mode stays read-only, the sandbox profile and your own
  deny rules still apply. Available from the composer, settings and agent permissions.

- 新增目标模式：`/goal <条件>` 创建目标，每轮结束后由独立判定者检查，未达成自动续轮，直到达成、
  判定不可能、预算耗尽或用户停止。输入框上方显示目标条，工作台新增目标面板，自动续轮显示为目标
  继续条，目标结束时显示结果卡（ADR-0047）。
  Adds goal mode: `/goal <condition>` starts a goal that an independent judge checks after each
  turn, auto-continuing until met, impossible, budget exhausted or stopped. A goal bar appears
  above the composer, a goal panel joins the workspace, auto-continuations render as a goal
  continuation row, and a result card marks the end (ADR-0047).

### Changed

- 内置技能由示例 `example` 换成 `grill-me`：逐个问题地追问，在写代码前把计划、设计或决策的风险
  问清楚；旧版对 `example` 的启用与固定偏好会被忽略。
  The built-in `example` skill is replaced by `grill-me`, which interviews the user one question
  at a time to stress-test a plan, design or decision before any code is written. Preferences
  saved for `example` are ignored.

## [0.1.5] - 2026-11-20

Beta 版本。Windows x64、macOS arm64/x64 与 Linux x64 的发布产物由发布流水线构建；未配置签名时 Windows/macOS 包标注为 unsigned。

### Added

- 右侧工作台新增后台任务面板：汇总当前会话的委派子 Agent、自动修复与后台命令，显示运行耗时；
  命令可展开输出并停止。工作台首页增加后台任务概览入口，随时间自动刷新。
- 安装并重启后弹窗展示本次版本的更新内容。

### Changed

- 启动明显加快：首屏只加载侧栏与新对话页，对话页、设置、活动、Agents、搜索与弹窗改为按需加载；
  首帧不再等设置读取，主进程的会话恢复挪到窗口创建之后并行执行，首屏重复请求合并，活动角标、
  技能与分支信息改到空闲时加载。暖启动窗口可见中位数 1435 ms → 750 ms，可输入 1280 ms → 887 ms。
- 首屏包体减小：语言包只加载当前语言、文件图标映射懒加载、首包去掉 zod 与协议 schema，
  生产主包 3.89 MB → 1.15 MB。
- 更新入口移到左栏 Cairn 标题行的图标：发现新版本显示下载图标，下载中显示进度环，完成后变成
  刷新图标，点击确认重启安装；设置的「更新」分类、关于页的更新信息与对话区的更新横幅移除。
- 工具活动组头只说最新一步在做什么并一律默认折叠，状态变化不再自动展开；待办进度开始一项才标
  进行中、完成立即标完成；`edit_file` 完成后显示增删行数；「本轮变更」超过 8 个文件时默认折叠。

### Fixed

- 失败提示、审批卡片这类整块内容出现时，对话区不再整块跳一下，改为逐帧缓动跟随到底部。
- 重试提示按秒倒数，不再一直停在「N 秒后重试」。
- 输入框在打开设置、活动中心等页面再回到对话时保留未发送的草稿与计划模式；新对话页按工作
  空间记住上次选的模型，并回到上次使用的工作空间。
- 摇树策略只作用于渲染进程，避免共享分块把宿主入口拉进主进程导致启动崩溃。

## [0.1.4] - 2026-11-19

Beta 版本。Windows x64、macOS arm64/x64 与 Linux x64 的发布产物由发布流水线构建；未配置签名时 Windows/macOS 包标注为 unsigned。

### Added

- 消息编辑重发与重新生成：编辑轮次开头的用户消息会从这条消息开始回退并用新内容重发；
  助手回复的轮次操作里可以重新生成这一轮。有后续轮次时先确认，工作区文件不会自动撤销
  （需要恢复文件仍用“撤销本轮”）。回退记为新事件 `conversation.rewound`，原始事件保留，
  模型历史与界面投影都跳过被丢弃的区间（ADR-0046）。
- 助手消息里的文件引用都可以点开右侧工作台：工具步骤里的路径、「本轮变更」的每一行，以及
  正文与行内代码里的文件名（裸文件名、`path:12`、常见扩展名都认）。带目录的按真实路径确认，
  只有文件名的在项目文件列表里取层级最浅的同名文件；有改动的文件直接显示 diff。
- 图片预览：png / jpg / gif / webp / avif / bmp / ico / svg 在右侧直接显示预览图；其他格式
  继续按文本高亮或二进制提示。
- 在会话里开启 PR 监视：创建 PR 后模型可以调用 `watch_pull_request`，征得同意后建立自动修复
  监视；活动中心可以逐条停止。
- 安装并重启后弹窗展示本次版本的更新内容：构建时从 `CHANGELOG.md` 抽取当前版本段落写入
  `build-info.json`，更新服务在安装前记录目标版本，启动后与当前版本一致时展示。

### Changed

- 执行过程改为状态图标与一句话组头：多步骤工具调用默认折叠，组头说明这一组做过什么与总耗时，
  运行中也保持折叠；失败、取消、等待审批时自动展开。文件路径带项目文件图标。
- 自动修复的设置入口与 `github.*` 渲染进程接口移除，令牌按 `GH_TOKEN` / `GITHUB_TOKEN` →
  旧版保存的凭据 → `gh auth token` 自动解析。
- 设置页的更新区域不再区分稳定版与 Beta，也不再显示通道选择；有更新时只保留一个「更新」按钮，
  点击后在后台下载，下载完成按钮变为「安装」。顶部更新提示条与安装前的重启确认保留。
- 回到底部按钮移到输入框正上方居中，提问、计划、记忆提案与任务进度等悬浮卡片出现时让位。

### Fixed

- 内容不足一屏时滚轮向上不再误解除贴底；内容缩回一屏以内时自动恢复贴底。
- 组头的失败 / 取消 / 等待审批语义修正；非零退出码只在它是这一组最后一步时才算失败。
- 工具步骤四栏对齐，技能这类没有动作词的步骤不再错位。

## [0.1.3] - 2026-11-19

Beta 版本。Windows x64、macOS arm64/x64 与 Linux x64 的发布产物由发布流水线构建；未配置签名时 Windows/macOS 包标注为 unsigned。

### Added

- 更新源支持公开仓库的 GitHub Releases：`CAIRN_UPDATE_URL` 写成
  `https://github.com/<owner>/<repo>` 时，客户端直接读取 release 资产，不需要额外存储、
  CDN 或令牌；beta 通道能检测到后续版本并显示更新按钮。

### Changed

- beta 版本也创建为正式 GitHub Release，Releases 页面与仓库侧栏直接显示可下载版本，
  不再因为预发布标记而看起来没有发布。

## [0.1.2] - 2026-11-18

Beta 版本。Windows x64、macOS arm64/x64 与 Linux x64 的发布产物需通过发布流水线验证；未配置签名时 Windows/macOS 包将标注为 unsigned。

### Added

- 自动修复（M8-01～M8-05）：设置页新增「自动修复」，可保存 GitHub 令牌、按仓库与 PR 编号
  查看 CI 检查状态与失败日志；令牌只保存在本机凭据存储，读取失败按 `github.*` 错误码提示
  （`docs/plan/auto-fix.md`）。
- 监视 PR：CI 失败、合并冲突或出现新的行内评审意见时，在独立的 worktree 里自动开启无人值守
  的修复会话；同一提交只修一次，冲突时先合并 base 分支，评审意见按评论 id 判断新旧。
- 受控提交与推送：修复会话用 `git_commit` / `git_push` 提交并推送到 PR 的 head 分支，只推该
  分支，拒绝强制推送、改写历史与 fork 分支；推送后回检，检查通过时标记并通知，次数用尽则停止
  监视（ADR-0045）。可选的在 PR 上回复评论（`pr_comment`）暂未接入。
- 活动中心新增「自动修复」分区：列出排队、修复中、已推送、检查通过或放弃的任务，并可跳到对应
  会话；「暂停全部」会立即停止排队中的任务并中止正在运行的修复，恢复后同一份失败可以重新尝试。

## [0.1.1] - 2026-11-18

Beta 版本。Windows x64、macOS arm64/x64 与 Linux x64 的发布产物需通过发布流水线验证；未配置签名时 Windows/macOS 包将标注为 unsigned。

### Added

- 工具步骤归组显示：一条助手消息中的工具调用自动归组，减少长回复视觉噪音；
  支持自动开合（执行中/异常时展开，正常结束后收起）并支持用户手动控制偏好。
- 用户提问：模型需要你在方案中选择或补充信息时，调用 `ask_user` 在输入框上方浮出选项卡片，
  多个问题逐题显示、可返回上一题、可随时取消，支持多选、自定义回答，并标出推荐项；回答后
  这一轮继续执行（ADR-0044）。
- Agents 管理页：从侧栏进入，列表可搜索与筛选，支持从空白创建或复制编程助手、
  编辑并保存草稿、查看版本与对比、恢复旧版本、预览生效配置；分区导航标出未保存、
  警告与错误。委派分区可以选择可委派的 Agent 与深度、并发、预算、工作区方式。
- Agent 试运行：用未发布的草稿开一次隐藏会话，默认只读，可切换到 Agent 自身的权限
  （会重启）；面板里能发送输入、停止、处理审批、查看与清除试运行历史。
- 输入框支持 `/` 指令面板、`/技能名` 与 `@Agent`、`@` 文件引用与拖入文件；
  指令、网址与代码片段高亮，消息里的路径可点击定位（#149、#155、#156、#158、#163）。
- 补全内置 `/` 指令：`/help` 查看全部指令与快捷键，`/agent`、`/permissions`、`/context`、
  `/status`、`/stop`、`/clear`、`/rename`、`/search`、`/memory`、`/delegation`、`/mcp`、
  `/skills`、`/providers` 直接完成对应操作。
- 文件树使用 Material 图标，文件标签可以直接预览（#159、#160）。
- 重做「添加供应商」弹窗，按接口格式选择服务（#162）。
- 运行中也能继续发送：消息直接出现在对话里，作为引导注入当前轮、在下次模型调用前生效，
  不打断正在执行的工具，也不会另起一轮；停止按钮保留。
- M5 发布硬化：应用身份、单实例、构建信息与关于页（M5-01）。
- 代码签名与发布流水线：PFX/Azure 签名、RFC 3161 时间戳、`signtool` 与
  Authenticode 双重校验、`latest.yml`/`beta.yml`、`SHA256SUMS`、依赖清单、
  构建来源证明与公开下载复验（M5-08）。
- 发布运行手册：证书轮换、更新源配置、dry-run、紧急撤包与恢复步骤
  （`docs/dev/release.md`）。
- 首次运行欢迎说明、专有 beta 许可、隐私说明与安装/故障排查文档；关于页补齐隐私、
  GPL 源码获取方式、诊断包与第三方许可入口（M5-09）。
- 发布验收：已打包应用全流程 e2e（首次运行、沙箱命令、无 Git 检查点、更新检查、许可、
  诊断包与重启恢复），以及真实 NSIS 安装/卸载/重装恢复与中文长路径验收
  （`pnpm e2e:packaged`、`pnpm acceptance:installed`），验收记录见
  `docs/plan/m5-report.md`（M5-10）。
- 跨平台支持：macOS arm64/x64 的 DMG 与 ZIP 打包、Developer ID 签名/公证校验与菜单适配；
  Linux 的 AppImage/deb、桌面项与校验和；无密钥环时明确拒绝保存凭据并说明原因；非 Windows
  平台在界面与事件里标注“未沙箱化”（ADR-0034、ADR-0040～0042）。
- 三平台 CI 与发布流水线：Windows/Ubuntu/macOS 的构建、打包校验与冒烟，DCO 校验，
  `prepare → build-* → assemble → publish` 与按平台的 `latest*.yml`、校验和、发布说明
  （ADR-0043）。
- 开源材料：MIT 许可证、CONTRIBUTING（DCO）、CODE_OF_CONDUCT、SECURITY、Issue/PR 模板与
  英文 README（M6-06）。
- 会话内 Agent 选择器：在输入框左下切换已发布 Agent，运行中禁用，支持搜索与快捷键
  （M6-08）。
- 记忆：Agent 可以跨会话记住项目约定与偏好，条目按本会话 / 本项目 / 所有项目严格隔离，
  只有确认过的内容会注入之后的对话；Agent 通过 `remember` 工具提议，浮出卡片由你确认或忽略，
  设置里可以允许自动记忆（默认关闭，M7-01～M7-03）。
- 记忆管理：设置页新增“记忆”分类，按范围分组、可搜索、就地编辑与删除，并显示状态与来源；
  会话信息面板新增“记忆”标签，只显示本会话、本项目与全局的条目，删除前确认（M7-04）。
- 记忆的隐私与删除：诊断包不含记忆正文（即使开启“包含会话正文”也只记录长度）；删除会话或
  项目时一并删除其记忆；隐私说明补充记忆条目（M7-05）。
- 审查循环：Agent 可以用 `review_loop` 让只读的 maker 起草、checker 审查，未通过时把意见
  带回 maker 再来一轮（最多 10 轮）；会话里显示每轮判定与最终结局（通过、轮次用尽、失败、
  已停止、触及限额），子运行仍只读并沿用委派限额（M7-07）。
- 流水线：Agent 可以用 `run_pipeline` 按依赖关系执行固定阶段，无依赖的阶段并发；某阶段失败
  后停止后续阶段并汇总原因，已完成阶段的结果保留；对话里显示阶段进度与跳过项（M7-08）。
- 团队模板：把常用的协作方式保存成模板（`delegate` / `review-loop` / `pipeline`），模板与 Agent
  一样有草稿、版本与发布，发布前先校验主控能否委派、成员与阶段引用是否完整（M7-06、M7-09）。
- 团队模板试运行：用模板草稿开一次隐藏会话，以主控 Agent 的草稿运行，模板的委派覆盖与协作
  说明并入这一轮；默认只读，可切换到主控自身的权限。试运行不出现在会话列表与用量统计里，
  发布后历史仍保留、可整体清理；模板改过草稿后，旧试运行记录的草稿哈希不再与新的一轮相同
  （M7-09）。

### Changed

- 模型供应商设置改为单栏：拉取的模型列表持久保存，与已配置模型合并显示并逐项启用；连接测试只测试已启用模型，低频设置按需展开（#201）。
- 三栏布局重构：去掉图标栏，左栏可拖宽、可收起，会话详情收进右侧工作台，侧栏入口精简
  （#150、#153、#154）。
- 输入框不再常驻「计划」开关，改为 `/plan` 指令与快捷键（#157）。
- 主题精简为跟随系统 / 浅色 / 深色（#153）。
- 待批准计划的操作（批准执行、重新规划、取消）改为浮在输入框上方的操作条，和提问卡片同一位置；
  取消只关闭这份计划，不执行也不开启新一轮，计划卡片标记为“已取消”。
- 聊天区状态显示优化：发送后不再留白，改为在消息末尾显示旋转的品牌图形与当前阶段（运行中 /
  思考中 / 正在调用工具 / 正在停止 / 等待审批），一旦开始输出或进入工具时间线就消失；工具调用
  步骤状态改用品牌图形（执行中旋转 / 成功绿色 / 失败红色），移除 ✓/✕ 与竖线，参数摘要不再显示
  原始 JSON，技能加载只显示技能名；计划进度的进行中与完成节点也改用品牌图形；去掉轮次之间的检查点分隔线。

### Fixed

- 修复提权宿主下沙箱子进程无法启动（`0xC0000142`）（#152）。
- 打包产物补齐 `electron-updater` 所需的 `resources/app-update.yml`，修复安装版下载更新时
  `ENOENT` 失败；`package:verify` 会校验该文件为 generic + HTTPS（M5-10）。

## [0.1.0] - 2026-11-10

首个公开 beta。Windows x64，按用户安装。

### Added

- 本地优先的桌面 Agent：会话、项目、文件改动、检查点与撤销。
- 模型供应商配置、凭据加密保存、权限规则与审批。
- 技能、MCP 服务、自定义 Agent、委派与隔离工作区。
- 活动中心、后台命令、运行检查器与脱敏诊断包。
- 中英文界面、四套内置主题与跟随系统。

### Changed

- 应用版本统一由根 `package.json` 提供，构建时写入版本、通道与提交信息。

### Security

- 单实例锁在打开数据库之前获取，避免两个实例同时写入。
- 诊断包导出前统一脱敏用户目录、API Key 与令牌。

[Unreleased]: https://github.com/960602906/Cairn/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/960602906/Cairn/releases/tag/v0.1.6
[0.1.2]: https://github.com/960602906/Cairn/releases/tag/v0.1.2
[0.1.1]: https://github.com/960602906/Cairn/releases/tag/v0.1.1
[0.1.0]: https://github.com/960602906/Cairn/releases/tag/v0.1.0
