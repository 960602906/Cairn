/** 日志与错误消息里的凭据按原文替换（ADR-0010）。 */
export function redactSecrets(value: string, secrets: readonly string[]): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join('[redacted]')
  }
  return result
}
