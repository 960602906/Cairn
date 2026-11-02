# S4：SQLite 引擎预研（M0-08）

## 问题

在所选 Electron 版本中，`better-sqlite3` 与 Node 内置的 `node:sqlite` 能否加载、开启 WAL、正确处理事务，写入吞吐如何，打包后能否运行（m0.md 第 4 节 S4，ADR-0006）。

## 版本

按最新稳定版选择（2026-11-02 npm 上的 `latest`）：

| 组件 | 版本 | 说明 |
|---|---|---|
| Electron | 45.2.1 | 内置 Node 24.22.1、SQLite 3.53.4，`process.versions.modules` = 150 |
| better-sqlite3 | 13.0.3 | 基于 Node-API（`node-addon-api`），包内自带各平台预编译文件，要求 Node ≥ 22 |
| electron-builder | 26.18.0 | 只做 `--dir` 打包，不生成安装包 |

本目录不属于 pnpm workspace，用 npm 独立安装，依赖不进入应用的锁文件和许可证检查。

## 检查项

`src/bench.mjs` 对两个引擎执行同一组检查，任何一步失败都记录在结果中：

- 加载耗时与 SQLite 版本；
- `PRAGMA journal_mode = WAL` 生效，`synchronous = NORMAL`；
- 事务提交、出错回滚、`SAVEPOINT` 部分回滚；
- WAL 下写事务进行中，另一个连接仍能读取已提交数据；
- 吞吐：2 万条事件按每 100 条一个事务写入；1000 条逐条自动提交写入；按会话读回 2 万行；
- `wal_checkpoint(TRUNCATE)`；
- 加载时 Node 是否发出 `ExperimentalWarning`。

## 运行

```sh
cd spikes/sqlite-engine
npm ci
node src/cli.mjs result-node.json                      # 纯 Node
npx electron src/main.mjs --out=result-electron.json   # Electron 主进程（Linux 需 xvfb-run，容器内加 --no-sandbox）
npx electron-builder --dir --publish never             # 打包到 out/
out/win-unpacked/SqliteEngineSpike.exe --out=result-packaged.json  # Windows 打包后运行
node src/summarize.mjs result-*.json                   # 汇总为表格
```

CI：`.github/workflows/spike-sqlite-engine.yml` 在 Windows 与 Linux 上执行以上全部步骤，表格写入作业摘要，结果文件作为构件上传。

## 决策标准

优先无需原生编译的方案，前提是 API 已稳定且所选 Electron 版本内置；否则用 better-sqlite3。

## 结果

Linux 容器（x64），2026-11-02。吞吐数字只用于判断量级，不同机器之间不可直接比较；Windows 结果见 PR 中的 CI 作业摘要。

| 环境 | 引擎 | 结果 | 加载 ms | 批量写入 行/秒 | 逐条提交 行/秒 | 读 2 万行 ms | 警告 |
|---|---|---|---|---|---|---|---|
| Node 22.23.4 | better-sqlite3 | 通过 | 6.6 | 83542 | 17301 | 45.2 | - |
| Node 22.23.4 | node:sqlite | 通过 | 0.6 | 162734 | 18797 | 70.3 | ExperimentalWarning |
| Electron 45.2.1 | better-sqlite3 | 通过 | 15.9 | 48733 | 16529 | 120.6 | - |
| Electron 45.2.1 | node:sqlite | 通过 | 0.3 | 70077 | 10893 | 137.5 | - |
| 打包后 | better-sqlite3 | 通过 | 5.5 | 164880 | 23095 | 32.1 | - |
| 打包后 | node:sqlite | 通过 | 0.3 | 207900 | 27322 | 38.0 | - |

观察：

1. 两个引擎在三种环境中都通过全部检查，使用的 SQLite 版本相同（3.53.4）。
2. **better-sqlite3 13 不再需要针对 Electron 重新编译。** 它改用 Node-API，预编译文件与 Node / Electron 的 ABI 无关；打包时设置 `npmRebuild: false` 仍能在 Electron 45 中加载。ADR-0006 原先认为它"需要针对 Electron 版本重新编译原生模块"，这一前提已不成立。
3. 打包要求：`*.node` 必须放在 `asarUnpack` 中。包内带全部 8 个平台的预编译文件（约 17 MB；已用 `files` 排除源码与 `deps/`），正式打包（M0-12）时应只保留目标平台的文件。
4. `node:sqlite` 在 Node 24.15 起标为 "Stability: 1.2 - Release candidate"（[Node 文档](https://nodejs.org/docs/v24.22.1/api/sqlite.md)），Electron 45 中加载时不再发出警告；但它尚未进入 Stability 2（稳定），最新版 Node 文档中仍是 1.2。
5. 性能两者处于同一量级，都远高于本应用的需要（估计流式过程中主进程每秒只落库几十条持久化事件，delta 不落库）。

## 结论

**使用 better-sqlite3 13。** `node:sqlite` 已内置且不需要原生编译，但 API 仍是候选版本，不满足"API 已稳定"的前提；而 better-sqlite3 13 改用 Node-API 后同样不需要针对 Electron 编译，原来选择内置模块的主要理由已不存在。

存储通过 `SessionStore` 等接口访问（ADR-0006），引擎只出现在 SQLite 实现内部。`node:sqlite` 进入稳定后可以重新评估，替换只影响 `packages/storage` 的 SQLite 实现，并由同一套契约测试保证行为一致。
