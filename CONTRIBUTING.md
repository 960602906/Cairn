# Contributing to Cairn / 参与贡献

Thanks for helping. This project uses the **MIT license** (see [LICENSE](LICENSE)) and the
**Developer Certificate of Origin (DCO)** instead of a CLA (see [ADR-0039](docs/adr/0039-open-source-license-and-dco.md)).

感谢参与。本项目使用 **MIT 许可证**（见 [LICENSE](LICENSE)）与 **DCO（Developer Certificate
of Origin）**，不要求签署 CLA（见 [ADR-0039](docs/adr/0039-open-source-license-and-dco.md)）。

## Before you start / 开始之前

- Read [docs/architecture.md](docs/architecture.md) and the [ADRs](docs/adr/README.md) for the
  boundaries the code depends on. Large changes should start as an issue or a draft PR.
- 阅读[架构设计](docs/architecture.md)与 [ADR](docs/adr/README.md)。较大的改动请先开 issue 或草稿 PR。

## DCO / 开发者原创声明

Every commit must certify that you have the right to submit it under the MIT license. Add a
`Signed-off-by` line to your commits:

每个提交都要声明你有权按 MIT 许可提交这些改动。请在提交信息里加上 `Signed-off-by`：

```bash
git commit -s -m "your message"
```

This produces a trailer like `Signed-off-by: Your Name <you@example.com>`. Do not add it for
someone else. DCO enforcement in CI is not enabled yet (see [ADR-0039](docs/adr/0039-open-source-license-and-dco.md)).

## Development setup / 开发环境

Requires **Node 24.11+** and **pnpm 10** (`corepack enable`).

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage   # 单元测试 + 四项覆盖率门槛（≥ 95%）
pnpm build           # 构建桌面应用
pnpm e2e             # 端到端测试（Linux 无显示器时用 xvfb-run -a pnpm e2e）
```

A pull request is ready when all of these pass. The full CI matrix (Windows + Ubuntu) runs the
same gates; macOS packaging is added in M6-02.

PR 就绪的标准是以上全部通过；完整 CI（Windows + Ubuntu）跑同样的门槛。

## Pull request checklist / PR 检查清单

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm check:i18n` /
      `pnpm check:licenses` pass.
- [ ] `pnpm test:coverage` passes; new behavior has tests (unit/integration/component/e2e — at
      least two kinds for behavior changes).
- [ ] UI changes include light and dark screenshots.
- [ ] Commits carry `Signed-off-by` (DCO).
- [ ] No secrets, internal hosts, personal paths or non-redistributable binaries are added.

## Reporting issues / 问题反馈

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security issues, **do not open a
public issue** — follow [SECURITY.md](SECURITY.md).

安全问题请勿公开提 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## License of contributions / 贡献的许可

By contributing, you agree that your contributions are licensed under the MIT license and that
the project's third-party components keep their own licenses (see the bundled notices).
