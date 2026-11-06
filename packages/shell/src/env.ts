/**
 * 子进程环境变量清洗（ADR-0012）：去掉密钥与应用内部变量，设 `PYTHONUTF8=1`（Python 默认按系统代码页输出，
 * 中文系统上是 GBK）。Windows 的环境变量名不区分大小写，判断一律忽略大小写。
 */

/** 名称像密钥的变量：以 `KEY`、`TOKEN`、`PASSWORD` 等结尾，或含 `SECRET`。 */
const SENSITIVE_NAME =
  /(?:^|_)(?:API_?KEY|KEY|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)$|SECRET/i

/** 应用内部变量：`CAIRN_*`（宿主配置、模型密钥、调试开关等），以及让 Electron 以 Node 方式运行的开关。 */
const INTERNAL_NAME = /^(?:CAIRN_|ELECTRON_RUN_AS_NODE$)/i

export const isSensitiveEnvName = (name: string): boolean =>
  SENSITIVE_NAME.test(name) || INTERNAL_NAME.test(name)

export interface SanitizeEnvOptions {
  /** 另外要去掉的变量名（不区分大小写）。 */
  readonly remove?: readonly string[]
}

export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  options: SanitizeEnvOptions = {},
): Record<string, string> {
  const remove = new Set((options.remove ?? []).map((name) => name.toUpperCase()))
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isSensitiveEnvName(name)) continue
    const upper = name.toUpperCase()
    if (remove.has(upper) || upper === 'PYTHONUTF8') continue
    result[name] = value
  }
  result['PYTHONUTF8'] = '1'
  return result
}
