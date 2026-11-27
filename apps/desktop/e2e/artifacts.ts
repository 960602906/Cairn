import path from 'node:path'

/**
 * E2E 截图目录：默认放在仓库的 `.cache`（已被忽略），可用 `CAIRN_E2E_ARTIFACTS` 覆盖。
 * 不写死 `/opt/cursor/artifacts`，否则在没有该目录或没有写权限的机器上用例会直接失败。
 */
export const E2E_ARTIFACTS =
  process.env['CAIRN_E2E_ARTIFACTS'] ??
  path.resolve(import.meta.dirname, '../../../.cache/cairn-e2e-artifacts')
