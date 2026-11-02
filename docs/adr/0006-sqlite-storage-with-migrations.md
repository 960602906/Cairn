# ADR-0006 使用 SQLite 存储并从第一天起支持迁移

- 状态：已接受
- 日期：2026-11-02（2026-11-02 补充引擎预研结论）

## 背景

最初建议先沿用 pi 的 JSONL 会话格式。但存储格式一旦有了用户数据就很难更改，而且 JSONL 不便于跨会话查询、统计和事务性写入。我们还需要存储改动记录、检查点索引、权限规则、提供方配置等结构化数据。

## 决定

- 使用 SQLite 作为本地数据库，开启 WAL 模式。
- 使用自定义的表结构（见架构文档 14.2），不绑定 pi 的格式。
- `schema_meta` 记录 schema 版本；启动时按顺序执行迁移脚本，迁移前自动备份数据库文件，失败时自动恢复。
- 文件内容快照存放在内容寻址的 blob 目录中，数据库只保存哈希引用。
- 只有主进程写入数据库。
- 通过 `SessionStore` 等接口访问存储，业务代码不直接写 SQL。
- 会话从一开始就区分 `projectPath` 与 `workspacePath`，为 git worktree 做准备。

## 备选方案

- **JSONL 文件**：简单易读，但查询和事务困难，迁移需要自己实现。
- **IndexedDB 或其他嵌入式数据库**：在 Electron 主进程中使用不便，生态不如 SQLite。

## SQLite 引擎（S4 预研结论，M0-08）

使用 **better-sqlite3**（13.x）。预研在 Electron 45.2.1（内置 Node 24.22.1）中比较了 better-sqlite3 13.0.3 与 Node 内置的 `node:sqlite`，覆盖纯 Node、Electron 开发运行与打包后运行，见 `spikes/sqlite-engine/README.md`：

- 两者都能加载、开启 WAL、正确处理事务与 SAVEPOINT，吞吐处于同一量级且远超需要。
- **better-sqlite3 13 改用 Node-API，自带各平台预编译文件，不再需要针对 Electron 版本重新编译**（打包时 `npmRebuild: false` 仍可加载）。原先认为它"需要重新编译原生模块"的缺点已不存在。
- `node:sqlite` 无需原生模块，但在 Node 24 中仍是 "Stability: 1.2 - Release candidate"，不满足"API 已稳定"的前提。

打包要求：`*.node` 放在 `asarUnpack` 中，只保留目标平台的预编译文件。引擎只出现在 `packages/storage` 的 SQLite 实现中；`node:sqlite` 进入稳定后可重新评估，替换由存储契约测试保证行为一致。

## 后果

- 需要编写迁移脚本和测试，但以后修改数据结构有章可循。
- 数据可备份、可查询，便于实现搜索和统计。
