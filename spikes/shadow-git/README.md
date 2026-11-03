# S5/S6：影子 Git 检查点预研

## 问题

- **S5**：在约 1 万个文件的仓库上创建 / 恢复检查点的耗时；`.gitignore` 与额外排除规则是否生效（m0.md 第 4 节，ADR-0008）。决策标准：Windows 上创建 < 2 秒、恢复 < 5 秒。
- **S6**：检查点使用的 Git 来源——本机 Git、随应用打包的 Git、isomorphic-git——的性能、许可证与分发合规；记录未安装 Git 时的降级方案（ADR-0008、ADR-0014）。

## 版本

2026-11-03 npm 上的 `latest`：

| 来源 | 版本 | 说明 |
|---|---|---|
| 本机 Git | 运行环境自带 | GitHub Actions 的 `windows-latest` 为 2.56.0.windows.4，`ubuntu-latest` 为 2.56.0；本地容器为 2.43.0 |
| 打包的 Git | dugite 3.3.2（内置 Git 2.56.0） | dugite 本身为 MIT；安装时下载 dugite-native（GitHub Desktop 使用的 Git 发行版，Windows 上基于 Git for Windows） |
| isomorphic-git | 1.44.10 | 纯 JS，MIT |

本目录不属于 pnpm workspace，用 npm 独立安装，依赖不进入应用的锁文件和许可证检查。

## 测试工作区

`src/fixture.mjs` 用固定种子生成，每种来源各生成一份：

- **应被快照的文件 1 万个**：20 个包、约 1000 个目录；大小 70% 为 0.5～4 KB、25% 为 4～32 KB、5% 为 32～256 KB，内容是可压缩程度接近源码的文本，共约 80 MB。
- **应被排除的**：
  - `.gitignore` 忽略的 `dist/`（300 个）、`*.log`，以及子目录 `.gitignore` 忽略的 `packages/p0/generated/`；
  - 没有写进 `.gitignore` 的 `node_modules/`（3200 个，包括子目录中的），由影子仓库的额外规则排除；
  - 超过 10 MiB 的文件（24 MiB；大改动时再新增一个 12 MiB 的）。
- **用户自己的仓库**：工作区根目录的 `.git`（有一个提交）。
- **嵌套仓库**：`vendor/lib`（有提交，相当于克隆下来的依赖）、`vendor/unborn`（刚 `git init`，没有提交）。
- **需要原样保存字节的**：CRLF 文本；LF 文本但 `.gitattributes` 写了 `*.txt text eol=crlf`；`.gitattributes` 标为 `filter=lfs` 的二进制文件。
- **文件名与元数据**：中文与空格（`docs/中文 文件名.md`），`& # [ ] !` 等字符；可执行位与符号链接（仅 Linux）。

## 流程与检查项

`src/bench.mjs` 对每种来源执行同一流程：

1. 首次检查点；
2. 无改动时再建一次（应复用上一个提交）；
3. 小改动 ×5（每次改 20、增 5、删 5 个文件，相当于一轮对话）；
4. 所有文件只改修改时间、内容不变（格式化工具、切换分支后常见；应复用上一个提交）；
5. 大改动（改 1000、增 500、删 500，含删掉整个目录；同时改动被忽略的文件、新增一个超大文件；相当于代码生成或批量格式化）；
6. 恢复到首次检查点，再撤销这次恢复，共 3 轮。恢复包含：先建检查点、生成预览（将被改动的文件列表）、改写工作区。

校验不依赖被测实现：每次检查点后，把检查点中的文件列表与按 fixture 规则独立算出的列表比对；每次恢复后，按内容哈希（含可执行位、符号链接目标）比对整个工作区，并确认被忽略的文件、超大文件、用户的 `.git` 与嵌套仓库都没有被改动。另检查：CRLF 与 LF 原样保留，中文文件名、被删除的目录能恢复，恢复后多出的目录被删除、不留下空目录。

最后记录影子仓库的大小与 `git gc` 的耗时。

## 影子仓库的做法

命令行实现在 `src/shadow-cli.mjs`，isomorphic-git 实现在 `src/shadow-iso.mjs`，流程相同。命令行实现的要点（M1-12 可直接沿用）：

- **与用户环境隔离**（`src/git-runner.mjs`）：去掉继承的 `GIT_*` 环境变量（`GIT_DIR`、`GIT_INDEX_FILE` 等会让命令作用到别的仓库）；`GIT_CONFIG_NOSYSTEM=1`，`GIT_CONFIG_GLOBAL` 指向空文件，用户的 `autocrlf`、钩子、签名、LFS 过滤器都不生效；`GIT_LITERAL_PATHSPECS=1`，路径中的 `*`、`[` 不被当作通配符。
- **仓库配置**：`init --template=`（不复制钩子样例）；`core.autocrlf=false`、`core.quotePath=false`、`core.longpaths=true`、`core.untrackedCache=true`；`core.excludesFile` 指向影子仓库自己的文件（否则仍会读用户的 `~/.config/git/ignore`）；`core.hooksPath` 指向不存在的目录；`gc.auto=0`；`commit.gpgSign=false`。屏蔽系统级配置后 Git for Windows 默认开启的 `core.fscache` 也随之关闭，需显式开启。
- **原样保存字节**：`info/attributes` 写入 `* -text -eol -filter -ident -working-tree-encoding`，优先级高于工作区中的 `.gitattributes`，不做换行转换，不调用 LFS 等过滤器（用户没装 git-lfs 时也不会失败）。
- **排除规则**：Git 在 `--work-tree` 下自动读取项目各级 `.gitignore`，从不收录 `.git`；额外规则（如 `node_modules/`）写进影子仓库的 `info/exclude`。
- **超大文件**：Git 没有按大小排除的选项。先用 `git status --porcelain=v2 -z --untracked-files=all` 列出有变化的文件并检查大小，超过上限的以精确路径写入 `info/exclude`，已被收录的用 `git rm --cached --pathspec-from-file=- --pathspec-file-nul` 移出；之后每次检查点重新检查名单中的文件，缩小到上限以内的会被重新收录。
- **创建**：`git add -A --ignore-errors` → `write-tree` → 树与上一个检查点相同则不建新提交 → `commit-tree` → `update-ref refs/nexus/checkpoints`。检查点是一条提交链，数据库记录提交 id。每次 5 个 Git 进程。
- **恢复**：先建检查点 → `diff-tree --name-status` 作为预览 → `read-tree -u --reset <目标>`。此时索引与刚建的检查点一致，`read-tree` 只改写有差异的文件，删除目标中没有的文件并清理空目录，被忽略的文件与超大文件不受影响。撤销恢复就是恢复到恢复前的那个检查点。
- **写对象的方式**（见下文结果）：`core.bigFileThreshold=1` 让 `git add` 把所有文件直接写进一个包文件，而不是每个文件一个松散对象；松散对象（此时只剩树与提交）不做 fsync。

## 运行

```sh
cd spikes/shadow-git
npm ci
node src/cli.mjs --out=result.json                                  # 三种来源，1 万个文件
node src/cli.mjs --source=system:pack-durable --files=2000          # 指定来源与配置变体
node src/summarize.mjs result.json                                  # 汇总为表格
```

来源为 `system`、`bundled`、`isogit`，命令行来源可带配置变体（`src/shadow-cli.mjs` 的 `CONFIG_VARIANTS`）。退出码只取决于 `--required` 中的来源（默认 `system,bundled`，含其全部变体），isomorphic-git 的已知缺陷记录在结果中，不让作业失败。

CI：`.github/workflows/spike-shadow-git.yml` 在 Windows 与 Linux 上运行三种来源与配置变体，表格写入作业摘要，结果文件作为构件上传。

## 结果

耗时单位 ms。GitHub Actions 托管机器之间波动较大（Windows 上同一配置两次运行可差 50%），只用于判断量级。下表各取一次完整运行。

**默认配置，三种来源（2026-11-03）**

| 平台 | 来源 | 首次 | 无改动 | 小改动（中位） | 只改时间 | 大改动 | 恢复（中位） | 撤销恢复（中位） | 预览 |
|---|---|---|---|---|---|---|---|---|---|
| Linux | 本机 Git | 2,098 | 127 | 144 | 774 | 431 | 363 | 593 | 29 |
| Linux | 打包的 Git | 2,145 | 119 | 146 | 724 | 445 | 371 | 344 | 29 |
| Linux | isomorphic-git | 18,354 | 2,154 | 2,550 | 3,910 | 14,445 | 3,703 | 3,537 | 214 |
| Windows | 本机 Git | 74,165 | 637 | 1,291 | 1,601 | 17,853 | 2,758 | 3,498 | 190 |
| Windows | 打包的 Git | 76,128 | 598 | 1,317 | 1,479 | 18,982 | 2,779 | 2,832 | 181 |
| Windows | isomorphic-git | 崩溃（EMFILE） | | | | | | | |

**写对象方式的配置变体，本机 Git**

| 平台 | 变体 | 首次 | 无改动 | 小改动（中位） | 只改时间 | 大改动 | 恢复（中位） | gc |
|---|---|---|---|---|---|---|---|---|
| Windows | 默认 | 74,165 | 637 | 1,291 | 1,601 | 17,853 | 2,758 | 31,716 |
| Windows | `nofsync`：不 fsync | 23,767 | 665 | 1,138 | 1,910 | 17,263 | 4,596 | 29,329 |
| Windows | `batch`：按批 fsync | 72,508 | 568 | 1,297 | 1,689 | 16,014 | 3,493 | 32,961 |
| Windows | `pack`：写包文件 | 16,830 | 580 | 1,157 | 1,515 | 7,755 | 2,767 | 2,347 |
| Windows | `pack-nofsync` | 11,593 | 661 | 786 | 1,537 | 3,085 | 2,656 | 2,332 |
| Linux | 默认 | 2,098 | 127 | 144 | 774 | 431 | 363 | 6,585 |
| Linux | `nofsync` | 2,214 | 127 | 141 | 762 | 446 | 429 | 6,129 |
| Linux | `pack` | 5,061 | 127 | 156 | 399 | 499 | 352 | 600 |
| Linux | `pack-nofsync` | 4,787 | 121 | 157 | 4,661 | 427 | 362 | 286 |

**推荐配置 `pack-durable`**：`core.bigFileThreshold=1`，`core.fsync=-loose-object,pack,pack-metadata,reference`（包文件与引用照常 fsync，只有树与提交这些松散对象不 fsync）。与 `pack-nofsync` 同一次运行：

| 平台 | 变体 | 首次 | 无改动 | 小改动（中位） | 只改时间 | 大改动 | 恢复（中位） | 撤销恢复（中位） | gc |
|---|---|---|---|---|---|---|---|---|---|
| Windows | 默认（同一次运行） | 123,150 | 886 | 1,685 | 1,755 | 54,851 | 2,824 | 2,795 | — |
| Windows | `pack-nofsync` | 12,210 | 654 | 801 | 1,516 | 4,141 | 2,617 | 3,667 | 2,335 |
| Windows | `pack-durable` | 12,057 | 602 | 790 | 1,542 | 4,432 | 2,541 | 2,753 | 2,798 |
| Linux | `pack-durable` | 6,592 | 126 | 169 | 6,345 | 494 | 400 | 380 | 394 |

Windows 上 `pack-durable` 各阶段的耗时（首次 / 大改动）：`status` 扫描 400 / 493，`git add` 9,485 / 2,792，写树与提交 2,173 / 1,147。

**来源本身**

| | 本机 Git | 打包的 Git | isomorphic-git |
|---|---|---|---|
| 分发体积（解压后） | 0 | Windows 105 MB、Linux 151 MB | 4.9 MB |
| 每个 Git 进程的启动开销 | Windows 约 34 ms，Linux 约 2 ms | 同左 | — |
| 嵌套仓库（有提交 / 没有提交） | 只记录提交 id（gitlink）/ 跳过并报错 | 同左 | 都当作普通文件快照（不含其 `.git`） |
| 恢复后留下的空目录 | 0 | 0 | 26 |

其他数据：影子仓库在全部步骤后约 35 MB（工作区中被快照的文件约 80 MB）；默认配置下有约 1.4 万个松散对象文件，`gc` 后为 12 个文件。

## 观察

1. **默认配置在 Windows 上不达标，瓶颈是逐个写松散对象。** 每个对象约 5～11 ms（Node 直接写文件约 1.4 ms），1 万个文件的首次检查点要 67～123 秒，大改动 17～55 秒。其中一部分是 fsync：Git for Windows 的平台默认会对松散对象 fsync，关掉后首次检查点降到 24 秒，但大改动几乎不变；其余是创建大量小文件本身的开销（推测主要来自实时防病毒扫描，托管机器上无法排除）。
2. **`core.bigFileThreshold=1` 让 `git add` 把所有文件写进一个包文件，是最有效的改动。** 首次检查点的 `git add` 从 66 秒降到 9.5 秒，`gc` 从 30 秒降到 2.3 秒。之后剩下约 1100 个树对象仍是松散对象，不 fsync 时写树只要 1～1.7 秒。代价：大于阈值的对象不做增量压缩（影子仓库大小基本不变，35 MB），`git diff` 会把它们当作二进制——检查点只需要文件列表，内容差异来自改动记录（ADR-0008），不受影响。Linux 上这种方式反而更慢（首次 2 秒 → 5～7 秒），因为 Linux 写松散对象很便宜。
3. **`core.fsync` 是在平台默认值上增减，不是替换。** 写 `pack,pack-metadata,reference` 不会去掉默认包含的 `loose-object`（这样配置时 Windows 上写树仍要 5～6 秒），需要写 `-loose-object`；改正后 `pack-durable` 与完全不 fsync 的 `pack-nofsync` 耗时相同。
4. **恢复在所有配置下都满足要求**：恢复约 2100 个文件的改动在 Windows 上 2.5～3.5 秒（其中先建检查点约 0.7 秒、预览 0.2 秒、改写工作区约 1.8 秒），Linux 上约 0.4 秒。
5. **固定开销**：Windows 上每个 Git 进程启动约 34 ms，`git status` 扫描 1 万个文件约 0.4 秒，所以没有改动时也要约 0.6 秒。可进一步优化：Git for Windows 内置的 `core.fsmonitor` 免去扫描；合并进程（如在影子仓库中让 `HEAD` 指向检查点分支，用一次 `git commit` 代替 `write-tree`、`commit-tree`、`update-ref`）。
6. **排除规则全部生效**：各级 `.gitignore`、额外规则、超大文件都没有进入检查点，恢复时也不被改动；用户的 `.git` 在全过程中逐字节不变；CRLF / LF、可执行位、符号链接、中文与特殊字符文件名都原样保存与恢复。
7. **嵌套仓库不在检查点范围内**：有提交的嵌套仓库只记录为 gitlink，恢复不改动其内容；没有提交的被跳过，`git add` 报错（需要 `--ignore-errors` 才能继续）。M1 应在 `git status` 结果中识别嵌套仓库，写进排除规则，并在界面上说明它们不受检查点保护。
8. **isomorphic-git 不可用**：Linux 上比 Git 命令行慢 6～10 倍（首次 14～34 秒、每次 2～5 秒），Windows 上在 1 万个文件的规模直接耗尽文件句柄（EMFILE）崩溃；`statusMatrix` 判断忽略规则时不传 `gitdir`，读的是工作区中用户仓库的 `.git/info/exclude`，影子仓库的额外规则不生效，需要逐个文件再判断一次；恢复后留下空目录；嵌套仓库的文件被当作普通文件快照。
9. **打包的 Git 与本机 Git 性能相同**（同为 2.56.0）。dugite 的发行包中检查点用不到的部分占大头（Linux 上 Git Credential Manager 80 MB、Git LFS 14 MB），且不附带任何许可证文本。

## 结论

**S5：影子 Git 检查点可行，但必须改用“写包文件”的配置。**

- 采用 `pack-durable` 配置后，Windows 上 1 万个文件：恢复 2.5～2.8 秒（标准 < 5 秒，满足）；日常检查点（无改动、一轮对话的小改动、所有文件只改时间）0.6～1.5 秒（标准 < 2 秒，满足）；一次改动 2000 个文件之后的那个检查点约 4 秒，首次检查点约 12 秒，不满足 2 秒。
- 首次检查点每个项目只发生一次（影子仓库跨会话保留），M1 在项目首次打开时于后台创建，并在界面显示进度，不阻塞第一轮对话；完成前到来的命令照常等待它完成。大批改动后的检查点超过 2 秒时只是让那次命令晚一些开始，不影响正确性；之后可用 `core.fsmonitor`、合并 Git 进程继续压缩。
- 不 fsync 松散对象的风险：断电时最近写入的树对象可能损坏。检查点只是安全网，M1 在打开影子仓库与恢复前发现对象缺失或损坏时，丢弃并重建影子仓库（失去旧检查点，不影响用户文件）。
- 每次创建检查点都会生成一个包文件，需要定期整理：空闲时执行 `git gc`（该配置下 Windows 约 2.5 秒），并按 ADR-0008 的清理策略删除旧检查点的引用后再 `gc --prune`。
- 排除规则按上文“影子仓库的做法”实现，全部检查通过；嵌套仓库不受检查点保护，需在界面上说明。

**S6：使用本机 Git；不打包 Git，不使用 isomorphic-git。**

> 评审后调整（2026-11-03，见 ADR-0008）：仍优先使用本机 Git，但 M5 起 Windows 安装包附带精简版 MinGit 作为兜底，避免没有安装 Git 的用户完全没有检查点。下文是预研当时的结论。

- **isomorphic-git 排除**：慢 6～10 倍，在 Windows 上这个规模会崩溃，忽略规则与恢复行为都有缺陷。
- **本机 Git 优先**：性能与打包的 Git 相同，不增加分发体积，没有 GPL 分发问题。要求 Git ≥ 2.32（`GIT_CONFIG_GLOBAL` 用于隔离用户配置；`core.fsync` 需 2.36，更早的版本会忽略它，只是更慢）。宿主启动时检测 `git --version`，之后可在设置中指定 Git 路径。
- **未安装 Git 或版本过低时的降级**：检查点不可用，界面常驻提示并给出安装 Git 的指引；写文件类工具的改动记录（ADR-0008 第一层）不依赖 Git，仍可整文件撤销；`run_command` 的审批卡片注明“此命令造成的改动无法自动回退”。
- **打包的 Git 留待 M5 打包时再评估**：需要时用 MinGit 或裁剪后的 dugite-native（去掉 Git Credential Manager、Git LFS，体积可减少一半以上），按 ADR-0014 单独登记：Git 为 GPLv2，作为独立程序随应用分发属于聚合，不影响本项目的许可证，但必须附带许可证文本并提供对应版本的源代码（或书面提供承诺）。dugite 的发行包不含这些材料，需自行补齐。
