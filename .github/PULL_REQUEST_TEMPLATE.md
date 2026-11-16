## 变更 / What changed

<!-- 一段话说明改了什么、为什么。One paragraph: what and why. -->

## 关联 / Related

<!-- Closes #NNN / 关联的 ADR 或计划任务 -->

## 验证 / Verification

<!-- 跑了哪些检查与测试；界面改动附浅色/深色截图。Which checks and tests ran; UI changes include light/dark screenshots. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm test:coverage`（四项覆盖率 ≥ 95%）
- [ ] `pnpm check:i18n`
- [ ] `pnpm check:licenses`
- [ ] 界面改动：附浅色与深色截图

## 检查清单 / Checklist

- [ ] 提交带 `Signed-off-by`（DCO，`git commit -s`）
- [ ] 没有新增密钥、内部地址、个人路径或不可分发的二进制
- [ ] 行为变更有测试；较大的设计变更已记录 ADR
- [ ] 用户可见文案已同时更新中英文（`packages/i18n`）
