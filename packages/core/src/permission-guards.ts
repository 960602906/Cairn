/**
 * 强制拦截（M1-10b；架构 §10.2）：危险命令与敏感文件。`allow` 规则与“自动”模式都不能放行，只有危险命令的
 * 询问可以由用户明确放行取消（见下）。
 *
 * - **直接拒绝**（`permission.blocked_command`）：会破坏工作区之外数据或系统的命令，例如递归删除根目录、
 *   家目录、盘符根目录与系统目录，格式化或覆写磁盘，fork 炸弹；
 * - **至少询问**（`permission.dangerous_command`）：用户明确放行（写明命令的用户规则，或审批时选择“始终允许”）
 *   后不再询问，“自动”模式不算明确放行。包括其他递归删除、强制推送与 `git push`、`git reset --hard`、
 *   `git clean -f`、提权（sudo、runas）、关机重启、修改注册表与执行策略、结束进程、发布包、下载后直接执行、
 *   `Invoke-Expression`、经 `-EncodedCommand` 传入的命令；
 * - **敏感文件**（`permission.sensitive_path`，询问）：`.env`、私钥与证书、SSH 目录、凭据文件；写入 `.git`
 *   目录。工具的路径与命令中出现的路径都检查。
 *
 * 识别 bash / zsh、PowerShell（含常用别名）与 cmd 的写法；`bash -c`、`powershell -Command`、`cmd /c`、`xargs`、
 * `$(…)` 与反引号中的命令也会检查。这是防误操作的安全网，不是安全边界（ADR-0007、架构 §10.5）：脚本、
 * 变量拼接等间接执行无法识别。
 */
import type { AgentPathPolicy } from '@cairn/protocol'
import { normalizeCommand, parseCommand } from './command-match.js'
import { matchGlob } from './glob.js'
import { PermissionReasonCode, type GuardResult, type PermissionGuard } from './permissions.js'

export const GuardReasonCode = {
  BlockedCommand: 'permission.blocked_command',
  DangerousCommand: 'permission.dangerous_command',
  SensitivePath: 'permission.sensitive_path',
} as const

const BLOCKED_REASON =
  'This command was blocked: it could destroy data outside the workspace or damage the system ' +
  '(for example recursive deletion of a root, home or system directory, or formatting a disk). ' +
  'It cannot be approved. Limit destructive operations to specific paths inside the workspace.'

const blocked: GuardResult = {
  effect: 'deny',
  reasonCode: GuardReasonCode.BlockedCommand,
  reason: BLOCKED_REASON,
}
const dangerous: GuardResult = {
  effect: 'ask',
  reasonCode: GuardReasonCode.DangerousCommand,
  overridable: true,
}
const sensitive: GuardResult = { effect: 'ask', reasonCode: GuardReasonCode.SensitivePath }

/** 取更严格的结果；同为询问时不可取消的优先。 */
const stricter = (a: GuardResult | undefined, b: GuardResult | undefined) => {
  if (!a) return b
  if (!b) return a
  if (a.effect !== b.effect) return b.effect === 'deny' ? b : a
  return a.overridable && !b.overridable ? b : a
}

// ---------- 敏感文件 ----------

/** 读写都需要询问的文件（相对工作区或命令中的路径，不区分大小写）。 */
export const SENSITIVE_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.aws/credentials',
  '**/.netrc',
  '**/_netrc',
  '**/.npmrc',
  '**/.pypirc',
  '**/.git-credentials',
  '**/.docker/config.json',
  '**/credentials.json',
]

/** `.env` 的示例文件不算敏感。 */
const SENSITIVE_EXCEPTIONS: readonly string[] = [
  '**/.env*.example',
  '**/.env*.sample',
  '**/.env*.template',
  '**/.env*.dist',
]

/** 只在写入时询问的位置：`.git` 目录（如 hooks 会被 Git 执行）。 */
export const SENSITIVE_WRITE_PATHS: readonly string[] = ['**/.git/**']

const matchesAny = (patterns: readonly string[], path: string) =>
  patterns.some((p) => matchGlob(p, path, { caseInsensitive: true }))

/** 去掉开头的 `/`、`~/`、盘符，使 `**\/` 开头的模式也能匹配绝对路径。 */
const relativeForm = (path: string) =>
  path
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\//, '')
    .replace(/^~\//, '')
    .replace(/^\/+/, '')

export function isSensitivePath(path: string, write = false): boolean {
  const rel = relativeForm(path)
  if (rel === '') return false
  if (write && matchesAny(SENSITIVE_WRITE_PATHS, rel)) return true
  return matchesAny(SENSITIVE_PATHS, rel) && !matchesAny(SENSITIVE_EXCEPTIONS, rel)
}

/** 工具路径中的敏感文件：读写都询问；写类工具写入 `.git` 时也询问。 */
export const sensitivePathGuard: PermissionGuard = (request) => {
  const write = request.definition.category !== 'read'
  const paths = request.targets.paths ?? []
  return paths.some((p) => isSensitivePath(p, write)) ? sensitive : undefined
}

// ---------- 危险命令 ----------

/** 按空白拆分一段命令，去掉引号（引号内的空白不拆）。 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | undefined
  let has = false
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      has = true
      continue
    }
    if (/\s/.test(char)) {
      if (has || current !== '') tokens.push(current)
      current = ''
      has = false
      continue
    }
    current += char
    has = true
  }
  if (has || current !== '') tokens.push(current)
  return tokens
}

/** 命令名：去掉路径与扩展名，小写。 */
const commandName = (token: string) =>
  (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')

const DELETE_COMMANDS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'])
const DISK_COMMANDS = new Set(['diskpart', 'format-volume', 'clear-disk', 'initialize-disk'])
const POWER_COMMANDS = new Set([
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'stop-computer',
  'restart-computer',
])
const KILL_COMMANDS = new Set(['kill', 'killall', 'pkill', 'taskkill', 'stop-process', 'spps'])
const ELEVATE_COMMANDS = new Set(['sudo', 'doas', 'su', 'runas', 'gsudo'])
const EVAL_COMMANDS = new Set(['iex', 'invoke-expression'])
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const PUBLISH = /^(npm|pnpm|yarn|bun|cargo|gem|dotnet|poetry|twine)$/

/** 递归删除的参数：`-r`、`-rf`、`--recursive`、PowerShell 的 `-Recurse`（及其前缀）、cmd 的 `/s`。 */
const isRecursiveFlag = (token: string) => {
  const t = token.toLowerCase()
  return (
    t === '--recursive' ||
    /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/.test(t) ||
    (/^-[a-z]{2,3}$/.test(t) && t.includes('r')) ||
    t === '/s'
  )
}

const isFlag = (token: string) => token.startsWith('-') || /^\/[a-z?]$/i.test(token)

/** 删除后果超出工作区的目标：根目录、家目录、盘符根目录、系统目录。 */
const ROOT_TARGET = new RegExp(
  [
    String.raw`^[\\/]+\*?$`,
    String.raw`^~[\\/]?\*?$`,
    String.raw`^\$\{?home\}?[\\/]?\*?$`,
    String.raw`^\$env:(userprofile|homedrive|systemdrive|systemroot|windir|programfiles)[\\/]?\*?$`,
    String.raw`^%(userprofile|homedrive|systemdrive|systemroot|windir|programfiles)%[\\/]?\*?$`,
    String.raw`^[a-z]:[\\/]?\*?$`,
    String.raw`^[\\/](bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var|users|applications|library|system)[\\/]?\*?$`,
    String.raw`^[a-z]:[\\/](windows|users|program files|program files \(x86\)|programdata)[\\/]?\*?$`,
  ].join('|'),
  'i',
)

/** 管道中下载后直接执行（`curl … | sh`、`iwr … | iex`）。 */
const DOWNLOAD_AND_RUN =
  /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|iex|invoke-expression|python3?|node|pwsh|powershell)\b/i
const FORK_BOMB = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/
const RAW_DISK = /(^|[\s>])(>|of=)\s*\/dev\/(sd|hd|nvme|disk|mmcblk|xvd|vd)/i

const MAX_DEPTH = 3

/** 一段命令（已拆分为词）。 */
function assessTokens(input: readonly string[], depth: number): GuardResult | undefined {
  let tokens = [...input]
  let result: GuardResult | undefined
  // 前缀：环境变量赋值、env / nohup / time / command 等、提权
  for (;;) {
    const first = tokens[0]
    if (first === undefined) return result
    const name = commandName(first)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) tokens = tokens.slice(1)
    else if (
      ['env', 'nohup', 'time', 'command', 'builtin', 'exec', 'nice', 'call'].includes(name)
    ) {
      tokens = tokens.slice(1)
    } else if (ELEVATE_COMMANDS.has(name)) {
      result = stricter(result, dangerous)
      tokens = tokens.slice(1)
      while (tokens[0]?.startsWith('-')) tokens = tokens.slice(1)
    } else break
  }
  const name = commandName(tokens[0]!)
  const args = tokens.slice(1)
  const lower = args.map((a) => a.toLowerCase())

  if (DELETE_COMMANDS.has(name)) {
    const recursive = args.some(isRecursiveFlag)
    const targets = args.filter((a) => !isFlag(a))
    if (recursive && targets.some((t) => ROOT_TARGET.test(t))) return blocked
    if (recursive) result = stricter(result, dangerous)
    // PowerShell：`Remove-Item -Path C:\ -Recurse`；cmd：`rd /s /q C:\`
  }
  if (name.startsWith('mkfs') || DISK_COMMANDS.has(name)) return blocked
  if (name === 'format' && args.some((a) => /^[a-z]:$/i.test(a))) return blocked
  if (name === 'dd' && lower.some((a) => /^of=\/dev\//.test(a))) return blocked
  if (name === 'git') result = stricter(result, assessGit(args))
  if (name === 'find' && lower.includes('-delete')) result = stricter(result, dangerous)
  if (
    (name === 'chmod' || name === 'chown') &&
    lower.some((a) => /^-\w*r/i.test(a) || a === '777')
  ) {
    result = stricter(result, dangerous)
  }
  if (
    POWER_COMMANDS.has(name) ||
    KILL_COMMANDS.has(name) ||
    EVAL_COMMANDS.has(name) ||
    name === 'reg' ||
    name === 'set-executionpolicy' ||
    name === 'regedit'
  ) {
    result = stricter(result, dangerous)
  }
  if (
    PUBLISH.test(name) &&
    (lower[0] === 'publish' || (name === 'twine' && lower[0] === 'upload'))
  ) {
    result = stricter(result, dangerous)
  }
  if (name === 'start-process' && lower.some((a, i) => a === '-verb' && lower[i + 1] === 'runas')) {
    result = stricter(result, dangerous)
  }
  // 嵌套的命令：bash -c、powershell -Command、cmd /c、xargs
  if (depth < MAX_DEPTH) result = stricter(result, assessNested(name, args, lower, depth))
  return result
}

function assessNested(
  name: string,
  args: readonly string[],
  lower: readonly string[],
  depth: number,
): GuardResult | undefined {
  if (POSIX_SHELLS.has(name)) {
    // `bash -c '…'`、`bash -lc '…'`：命令是紧跟的一个参数
    const index = lower.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a))
    const inner = index >= 0 ? args[index + 1] : undefined
    return inner === undefined ? undefined : assessCommand(inner, depth + 1)
  }
  if (name === 'pwsh' || name === 'powershell') {
    // 经 -EncodedCommand 传入的命令无法检查
    if (lower.some((a) => a === '-e' || a === '-ec' || a.startsWith('-enc'))) return dangerous
    const index = lower.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(a))
    return index >= 0 ? assessCommand(args.slice(index + 1).join(' '), depth + 1) : undefined
  }
  if (name === 'cmd') {
    const index = lower.findIndex((a) => a === '/c' || a === '/k')
    return index >= 0 ? assessCommand(args.slice(index + 1).join(' '), depth + 1) : undefined
  }
  if (name === 'xargs') {
    const rest = args.findIndex((a) => !a.startsWith('-'))
    return rest >= 0 ? assessTokens(args.slice(rest), depth + 1) : undefined
  }
  return undefined
}

function assessGit(args: readonly string[]): GuardResult | undefined {
  // 跳过 `-C <dir>`、`-c <k=v>` 等全局参数
  let i = 0
  while (i < args.length && args[i]!.startsWith('-'))
    i += args[i] === '-c' || args[i] === '-C' ? 2 : 1
  const sub = args[i]?.toLowerCase()
  const rest = args.slice(i + 1)
  switch (sub) {
    case 'push':
      // 推送到远端是对外操作；强制推送还会覆盖他人的提交
      return dangerous
    case 'reset':
      return rest.includes('--hard') ? dangerous : undefined
    case 'clean':
      return rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force') ? dangerous : undefined
    case 'branch':
      // `-D` 删除未合并的分支
      return rest.some((a) => /^-[a-zA-Z]*D/.test(a)) ||
        (rest.includes('--delete') && rest.includes('--force'))
        ? dangerous
        : undefined
    case 'filter-branch':
    case 'filter-repo':
      return dangerous
    default:
      return undefined
  }
}

/** 命令替换中的命令：`$(…)` 与反引号。 */
const substitutions = (command: string) => [
  ...[...command.matchAll(/\$\(([^()]*)\)/g)].map((m) => m[1]!),
  ...[...command.matchAll(/`([^`]*)`/g)].map((m) => m[1]!),
]

/** 评估整条命令；不危险时返回 undefined。 */
export function assessCommand(command: string, depth = 0): GuardResult | undefined {
  const normalized = normalizeCommand(command)
  if (FORK_BOMB.test(normalized) || RAW_DISK.test(normalized)) return blocked
  let result: GuardResult | undefined
  if (DOWNLOAD_AND_RUN.test(normalized)) result = dangerous
  for (const segment of parseCommand(command).segments) {
    const tokens = tokenize(segment)
    result = stricter(result, assessTokens(tokens, depth))
    if (result?.effect === 'deny') return result
    // 命令中出现的敏感文件（如 `cat .env`、`type C:\Users\me\.ssh\id_rsa`）
    if (tokens.slice(1).some((t) => isSensitivePath(t))) result = stricter(result, sensitive)
  }
  if (depth < MAX_DEPTH) {
    for (const inner of substitutions(command)) {
      result = stricter(result, assessCommand(inner, depth + 1))
      if (result?.effect === 'deny') return result
    }
  }
  return result
}

/** 命令中的危险操作与敏感文件。 */
export const dangerousCommandGuard: PermissionGuard = (request) =>
  request.targets.command === undefined ? undefined : assessCommand(request.targets.command)

/** 默认的强制拦截：危险命令与敏感文件。 */
export const DEFAULT_PERMISSION_GUARDS: readonly PermissionGuard[] = [
  dangerousCommandGuard,
  sensitivePathGuard,
]

/**
 * Agent 级写入路径守卫（M4-11）：`pathPolicy.write` 给出时，写类工具只能修改匹配的路径。
 *
 * 这是硬边界，不依赖提示词；空路径、缺少规范化目标或任一目标越出白名单都直接拒绝。读取与执行不受影响，
 * 仍由 Agent 的工具选择、权限预设与默认强制规则决定。
 */
export function createAgentPathGuard(
  policy: AgentPathPolicy | undefined,
  options: { readonly caseInsensitive?: boolean } = {},
): PermissionGuard {
  const allowed = policy?.write ?? []
  if (allowed.length === 0) return () => undefined
  return (request) => {
    if (request.definition.category !== 'write') return undefined
    const paths = request.targets.paths ?? []
    const permitted =
      paths.length > 0 &&
      paths.every((path) =>
        allowed.some((pattern) =>
          matchGlob(pattern, path, {
            ...(options.caseInsensitive !== undefined
              ? { caseInsensitive: options.caseInsensitive }
              : {}),
          }),
        ),
      )
    if (permitted) return undefined
    return {
      effect: 'deny',
      reasonCode: PermissionReasonCode.AgentPathDenied,
      reason:
        'This agent may only write test files. Use a test directory or a *.test.* / *.spec.* file.',
    }
  }
}
