/**
 * PowerShell 的包装脚本（ADR-0012，S7 预研结论）。
 *
 * - 前置脚本把输出与文件读写编码设为无 BOM 的 UTF-8，关闭进度条与颜色；
 * - 用户脚本以 UTF-8 Base64 嵌入，在前置脚本之后用 `[ScriptBlock]::Create` 解析并点执行：用户脚本有语法
 *   错误时前置脚本已经生效，错误信息同样按 UTF-8 输出；
 * - 错误流由脚本写到 stderr（Windows PowerShell 5.1 即使加 `-OutputFormat Text` 仍以 CLIXML 输出错误流）；
 * - 结尾在最后一条原生命令失败时以它的退出码退出（否则 PowerShell 只返回 0 或 1）。
 */

/** 前置脚本：输出编码统一为 UTF-8（无 BOM），关闭进度条与颜色，文件读写默认 UTF-8。 */
export const POWERSHELL_PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$__cairnUtf8 = New-Object System.Text.UTF8Encoding $false',
  'try { [Console]::OutputEncoding = $__cairnUtf8; [Console]::InputEncoding = $__cairnUtf8 } catch {}',
  '$OutputEncoding = $__cairnUtf8',
  "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
  "if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'PlainText' }",
  // 原生程序的 stderr 只取原文；PowerShell 错误附上位置信息（行号、出错的代码）
  'function Format-CairnError($e) {',
  "  if ($e.FullyQualifiedErrorId -like 'NativeCommandError*') { return $e.ToString() }",
  '  $m = $e.Exception.GetBaseException().Message',
  '  if ($e.InvocationInfo -and $e.InvocationInfo.PositionMessage) { $m += [Environment]::NewLine + $e.InvocationInfo.PositionMessage }',
  '  return $m',
  '}',
].join('\n')

/** 结尾：最后一条原生命令失败时，以它的退出码退出。 */
export const POWERSHELL_EPILOGUE =
  'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'

/** 把用户脚本包装为最终执行的脚本（前置脚本 + 脚本块执行 + 结尾）。 */
export function wrapPowerShellScript(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return [
    POWERSHELL_PRELUDE,
    `$__cairnScript = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`,
    'try {',
    '  . ([ScriptBlock]::Create($__cairnScript)) 2>&1 | ForEach-Object {',
    '    if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine((Format-CairnError $_)) } else { $_ }',
    '  }',
    '} catch {',
    '  [Console]::Error.WriteLine((Format-CairnError $_))',
    '  exit 1',
    '}',
    POWERSHELL_EPILOGUE,
  ].join('\n')
}

/** `-EncodedCommand` 的参数：UTF-16LE 的 Base64。 */
export const encodePowerShellCommand = (script: string): string =>
  Buffer.from(script, 'utf16le').toString('base64')

/** 所有 PowerShell 调用共用的参数。 */
export const POWERSHELL_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text']
