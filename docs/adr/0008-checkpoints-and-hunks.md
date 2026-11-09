# ADR-0008 检查点与按块改动记录

- 状态：已接受
- 日期：2026-11-02（2026-11-03 补充检查点预研结论）

## 背景

用户需要审阅和撤销 agent 的改动。只记录写文件工具的前后内容还不够：`run_command` 可以修改任意文件（例如格式化工具、代码生成器、包管理器），这些改动无法通过工具记录捕获。回退能力如果后补，需要改动工具层、存储层和界面，因此必须现在设计。

## 决定

采用两层机制：

1. **改动记录**：写文件类工具执行前后计算 diff，按块（hunk）存入数据库，文件内容存为内容寻址的 blob。界面第一版提供整文件接受/撤销，后续增加按块操作只需修改界面。
2. **检查点**：在应用数据目录中为每个项目维护一个影子 Git 仓库（`--git-dir` 指向应用目录，`--work-tree` 指向工作区），不触碰用户自己的 `.git`。在每轮开始和每次执行命令前创建快照，可以把工作区恢复到任意检查点。恢复前自动再创建一个检查点，使回退本身可撤销。

## 备选方案

- **只记录写文件工具的改动**：无法覆盖命令造成的改动。
- **直接使用用户的 Git 仓库**（stash 或临时提交）：会污染用户的提交历史和暂存区，且项目不一定是 Git 仓库。
- **完整复制项目目录**：对大型项目代价过高。

## 检查点性能与 Git 来源（S5/S6 预研结论）

预研在约 1 万个文件的工作区上比较了本机 Git、随应用打包的 Git（dugite，Git 2.56.0）与 isomorphic-git，Windows 与 Linux 均在 CI 中运行，见 `spikes/shadow-git/README.md`：

- **优先使用本机 Git**（≥ 2.32），宿主启动时检测，之后可在设置中指定路径。
- **M5 起随应用附带精简版 MinGit 作为兜底**（2026-11-03 决定）：用户以 Windows 为主，很多人没有安装 Git，只靠本机 Git 会让这部分用户完全没有检查点，`run_command` 的改动无法回退。本机没有可用的 Git（未安装或版本过低）时改用附带的 MinGit。M1～M4 期间还没有附带版本，此时检查点不可用并在界面提示，写文件类工具的改动记录仍可撤销，`run_command` 的审批中注明命令的改动无法自动回退。
- **不使用 isomorphic-git**：比 Git 命令行慢 6～10 倍，Windows 上在这个规模耗尽文件句柄崩溃，忽略规则与恢复行为有缺陷。
- **附带的 Git**：性能与本机 Git 相同。用裁剪后的 MinGit（去掉 Git Credential Manager、Git LFS 等检查点用不到的部分），按 ADR-0014 单独登记：Git 为 GPLv2，作为独立程序随应用聚合分发，不影响本项目的许可证，但须附许可证文本并提供对应版本源代码的获取方式。Linux、macOS 用户通常已有 Git，M6 再评估是否附带。
- **影子仓库必须改用写包文件的配置**：默认配置下 Git 为每个文件写一个松散对象，Windows 上首次检查点 67～123 秒。设置 `core.bigFileThreshold=1`（`git add` 把文件写入一个包文件）与 `core.fsync=-loose-object,pack,pack-metadata,reference` 后，Windows 上恢复约 2.5 秒，日常检查点 0.6～1.5 秒，首次检查点约 12 秒、改动 2000 个文件后的检查点约 4 秒。首次检查点在项目首次打开时于后台创建。
- 与用户环境隔离：去掉 `GIT_*` 环境变量，屏蔽系统级与用户级配置；`info/attributes` 写入 `* -text -eol -filter -ident -working-tree-encoding`，按原样保存字节、不调用 LFS 等过滤器。
- 排除规则：项目各级 `.gitignore` 自动生效，额外规则写入影子仓库的 `info/exclude`；超过大小上限的文件按精确路径排除。嵌套仓库只记录为 gitlink 或被跳过，不受检查点保护，需在界面上说明。
- 恢复：先建检查点，再以 `diff-tree` 生成预览、`read-tree -u --reset` 改写工作区；被忽略的文件与超大文件不受影响，多出的目录被清理。
- 松散对象不 fsync，断电时最近的检查点可能损坏；发现损坏时丢弃并重建影子仓库。每次检查点生成一个包文件，空闲时执行 `git gc`（约 2.5 秒）。

## 后果

- M5 之前检查点依赖用户安装 Git；未安装时只有写文件类工具的改动可以撤销。M5 起 Windows 安装包附带 MinGit，体积增加（裁剪后预计数十 MB，M5 时实测）。
- 检查点占用磁盘空间，需要清理策略。
- 被排除的目录（如 `node_modules`）中的改动无法回退，需在界面上说明。
- M4 的隔离工作区以检查点提交为基线创建 `git worktree`，见 ADR-0031；检查点仍只保存工作区快照，不负责子运行的改动集合并。

## M5 变更（M5-03 已定稿，2026-11-10）

**来源固定**：`git-for-windows` 的 `MinGit-2.56.0.4-64-bit.zip`，tag
`v2.56.0.windows.4`，官方 SHA256
`e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877`。
`scripts/fetch-mingit.mjs` 先请求 GitHub Releases，失败时回退 npmmirror 镜像，两者都以
上述 SHA256 为准；下载缓存在 `.cache/mingit/`（不提交）。

**裁剪结果**：压缩包 39,846,926 字节（38.0 MiB），完整解压 96,237,338 字节；正式脚本
裁剪后为 **64 个文件、23,915,125 字节（22.8 MiB）**。保留 `LICENSE.txt`、`cmd/`、
`ucrt64/bin`（或 `mingw64/bin`）、`ucrt64/libexec/git-core` 与
`share/git-core/templates`。删除文档、locale、perl、MSYS 开发工具、`scalar`、
Git Credential Manager、`git-remote-http(s)` 与 HTTP 传输助手、Git LFS，以及
Avalonia / Skia / HarfBuzz / .NET 界面依赖。

**运行时注入**：主进程的 `createGitLocator` 只探测一次并缓存，顺序为本机 Git（≥ 2.32）
→ 随包 MinGit；`CAIRN_GIT_BINARY` 强制指定可执行文件，`CAIRN_GIT_DISABLE_BUNDLED=1`
关闭随包兜底。随包路径由 `bundledGitEnv` 给出受控的 `GIT_EXEC_PATH`、
`GIT_TEMPLATE_DIR` 与只前置其 `bin` 的 `PATH`，不接受用户环境中的同名变量。定位结果经
`host.init.git = { binary, env }` 传给宿主，检查点、改动集、隔离工作区与宿主共用同一
结果；不可用时保持“检查点降级、写文件类改动仍可撤销”的既有行为。

**启动顺序**：主进程在创建窗口/宿主之前定位 Git，并把来源与版本写入 `AppInfo.git`
（`system` / `bundled` / `unavailable`，不含路径）。关于页、诊断包的
`app-version.json` 与 `build-info.json` 都显示或记录该摘要。

**体积增量**（M5-03 本地未签名构建，与 M5-02 同机对比）：随包目录 23,915,125 字节
（64 个文件，22.8 MiB）；`win-unpacked` 从 401,726,853 增至 425,674,879 字节
（+23,948,026，+22.8 MiB）；NSIS 安装包从 126,295,216 增至 134,380,471 字节
（+8,085,255，+7.7 MiB），blockmap 140,795 字节。安装包因压缩小于随包目录的原始体积；
构建时间与资源时间戳会让每次产物的字节数略有不同，以生成的 `.sha256` 为准。

**验收证据**：

- `apps/desktop/src/agent-host/bundled-git.test.ts` 用随包二进制与受控环境变量，在不含
  系统 Git 的 `PATH` 下真实完成 `openShadowRepo` → `checkpoint` → `preview` →
  `restore`，版本为 `2.56.x`。
- `scripts/fetch-mingit.test.ts` 覆盖固定 SHA、镜像回退、裁剪白/黑名单、临时目录真实 Git
  冒烟，以及失败时不替换现有产物。
- `verify-package` / `smoke:packaged` / `smoke:installed` 校验安装包内
  `resources/git/LICENSE.txt`、`ucrt64/bin/git.exe` 与 `git version 2.56`，并禁止
  `git-remote-http(s).exe` 与 `scalar.exe`。
- 许可证：`scripts/bundled-binaries.json` 登记 MinGit 2.56.0.4（GPL-2.0-only），
  `scripts/licenses/mingit/LICENSE` 收录 GPLv2 全文与源码获取地址，
  `scripts/license-exceptions.json` 记录独立程序聚合分发的理由；CI 的许可证检查与
  第三方声明自动包含。

**未完成/留给 M5-10**：干净 Windows VM、无 Git 的标准用户账户、中文用户名与长路径上的
安装/升级/卸载仍需实测；本任务只证明“随包 Git 在自动化与本地打包中可用”。安装包体积
增量在 M5-03 的打包验证中记录，最终分发体积以 M5-08 的签名产物为准。
