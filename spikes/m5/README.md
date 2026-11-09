# M5-00 预研脚本

本目录不进入根 pnpm workspace，只用于 M5-00 的可复现预研。结论与完整结果见 [`docs/plan/m5-spikes.md`](../../docs/plan/m5-spikes.md)。

## 准备

```powershell
cd spikes/m5
pnpm install --ignore-workspace --registry=https://registry.npmjs.org/
```

S2 需要先在仓库根目录构建桌面端：

```powershell
pnpm build
```

## 脚本

| 脚本 | 内容 | 主要产物 |
|---|---|---|
| `src/s1-sandbox.mjs` | 受限令牌 / AppContainer 真实命令矩阵 | `result-s1.json` |
| `src/s2-package.mjs` | 扁平生产依赖 + electron-builder `--dir` / NSIS | `out/s2/`、检查脚本控制台输出 |
| `src/s3-update-source.mjs` | 本地 HTTPS 静态源 + electron-updater 检查/下载/失败路径 | `result-s3.json` |
| `src/s4-mingit.mjs` | MinGit 下载、SHA256、裁剪与 Git 命令 | `result-s4.json` |
| `src/check-package.mjs` | 检查 asar、asarUnpack、资源、安装包与 blockmap | 控制台输出 |

## 注意

- `work/`、`out/`、`downloads/` 与 `result-*.json` 已被忽略，不能提交。
- S1 需要 Windows；S3 使用自签名证书，只用于本地预研。
- S2 的 runtime dependency 清单是预研候选；M5-02 应改为从构建产物自动校验。
- 这些脚本不替代 M5-02/M5-06 的正式打包、安装与更新测试，也不替代 M5-10 的干净 VM 验收。
