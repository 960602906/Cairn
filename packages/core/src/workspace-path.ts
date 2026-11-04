/**
 * 工作区路径校验：纯路径规则（M1-06a；架构 §17、§18）。
 *
 * `resolveWorkspacePathLexical(root, input, style)` 不访问文件系统，只按路径文本规范化并判断是否位于工作区内。
 * 符号链接、目录联接、真实路径与不存在的文件在 M1-06b 处理（在本函数的结果上再校验真实路径）。
 *
 * core 不依赖 Node（界面也使用 core），因此不用 `node:path`，按两种风格自行解析；测试中与 Node 的
 * `path.posix` / `path.win32` 对照。
 *
 * 规则：
 * - 相对路径相对工作区根目录解析；绝对路径也接受，但必须位于工作区内。
 * - `.` 与空段忽略，`..` 回到上一级（不会越过文件系统根）；规范化后必须等于根目录或位于其下。
 * - 越界、格式错误时返回错误码，不抛出。
 * - Windows（`win32`）：
 *   - `/` 与 `\` 都是分隔符；盘符与路径比较时忽略大小写，返回的绝对路径中工作区部分沿用根目录的写法；
 *   - `\\?\C:\…` 与 `\\?\UNC\server\share\…` 去掉前缀后按普通路径处理；`\\.\` 设备路径拒绝；
 *   - `C:foo`（相对某个盘的当前目录）拒绝；`\foo` 按根目录所在的盘解析；
 *   - 段末尾的 `.` 与空格去掉（Windows 打开文件时同样忽略，避免 `.env.` 绕过规则）；只由点与空格组成的
 *     段（`...`、`.. `）拒绝；
 *   - 段中出现 `:`（备用数据流）、`<>"|?*` 或控制字符时拒绝；保留设备名（`CON`、`NUL`、`COM1` 等）拒绝。
 * - posix：只有 `/` 是分隔符，大小写敏感，`\` 是普通字符。
 * - 任何风格下包含 NUL 字符都拒绝。
 */
import type { PathResolution } from './tools.js'

export type PathStyle = 'posix' | 'win32'

export const PathErrorCode = {
  /** 路径为空或只有空白。 */
  Empty: 'path.empty',
  /** 含有不允许的字符（NUL；Windows 下还有 `:`、`<>"|?*`、控制字符）。 */
  InvalidCharacter: 'path.invalid_character',
  /** 格式不完整，例如缺少共享名的 UNC 路径。 */
  Malformed: 'path.malformed',
  /** Windows `C:foo` 形式：相对某个盘的当前目录，含义不确定。 */
  DriveRelative: 'path.drive_relative',
  /** Windows 设备路径（`\\.\`）或保留设备名（`CON`、`NUL` 等）。 */
  Device: 'path.device',
  /** 规范化后不在工作区内。 */
  OutsideWorkspace: 'path.outside_workspace',
  /** 工作区根目录不是绝对路径（调用方错误）。 */
  RootNotAbsolute: 'path.root_not_absolute',
} as const

export type PathErrorCode = (typeof PathErrorCode)[keyof typeof PathErrorCode]

type Parsed =
  | {
      readonly ok: true
      /**
       * 绝对路径的前缀：posix 为 `/`，Windows 为 `C:` 或 `\\server\share`；`\foo` 为空串且
       * `driveRootRelative` 为 true；相对路径为 undefined。
       */
      readonly prefix: string | undefined
      readonly driveRootRelative: boolean
      readonly segments: readonly string[]
    }
  | { readonly ok: false; readonly code: PathErrorCode }

const fail = (code: PathErrorCode) => ({ ok: false as const, code })

// eslint-disable-next-line no-control-regex -- 显式匹配控制字符
const WIN_INVALID = /[<>"|?*:\u0000-\u001f]/
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i

function parsePosix(input: string): Parsed {
  return {
    ok: true,
    prefix: input.startsWith('/') ? '/' : undefined,
    driveRootRelative: false,
    segments: input.split('/').filter((s) => s !== '' && s !== '.'),
  }
}

function winSegments(
  rest: string,
): { ok: true; segments: string[] } | { ok: false; code: PathErrorCode } {
  const segments: string[] = []
  for (const raw of rest.split('\\')) {
    if (raw === '' || raw === '.' || raw === '..') {
      if (raw === '..') segments.push(raw)
      continue
    }
    if (WIN_INVALID.test(raw)) return fail(PathErrorCode.InvalidCharacter)
    // 只由点与空格组成的段（`...`、`.. `）在不同 API 下含义不一致，直接拒绝。
    if (/^[. ]+$/.test(raw)) return fail(PathErrorCode.Malformed)
    // Windows 打开文件时去掉段末尾的点与空格（`.env.` 即 `.env`）。
    const segment = raw.replace(/[. ]+$/, '')
    // 保留设备名：主名（第一个点之前，去掉末尾空格）匹配即视为设备，扩展名不影响。
    const stem = segment.split('.')[0]!.replace(/ +$/, '')
    if (WIN_RESERVED.test(stem)) return fail(PathErrorCode.Device)
    segments.push(segment)
  }
  return { ok: true, segments }
}

function parseWin32(original: string): Parsed {
  let input = original.replace(/\//g, '\\')
  // 扩展长度前缀：`\\?\` 与 NT 对象前缀 `\??\`
  const extended = /^\\\\\?\\|^\\\?\?\\/.exec(input)
  if (extended) {
    input = input.slice(extended[0].length)
    if (/^unc\\/i.test(input)) input = `\\\\${input.slice(4)}`
    else if (!/^[a-z]:\\/i.test(input)) return fail(PathErrorCode.Device)
  }
  if (input.startsWith('\\\\')) {
    if (/^\\\\[.?]\\/.test(input)) return fail(PathErrorCode.Device)
    const [server = '', share = '', ...rest] = input.slice(2).split('\\')
    if (server === '' || share === '') return fail(PathErrorCode.Malformed)
    if (WIN_INVALID.test(server) || WIN_INVALID.test(share)) {
      return fail(PathErrorCode.InvalidCharacter)
    }
    const parsed = winSegments(rest.join('\\'))
    if (!parsed.ok) return parsed
    return {
      ok: true,
      prefix: `\\\\${server}\\${share}`,
      driveRootRelative: false,
      segments: parsed.segments,
    }
  }
  const drive = /^([a-z]):/i.exec(input)
  if (drive) {
    const rest = input.slice(2)
    if (!rest.startsWith('\\')) return fail(PathErrorCode.DriveRelative)
    const parsed = winSegments(rest)
    if (!parsed.ok) return parsed
    return {
      ok: true,
      prefix: `${drive[1]!.toUpperCase()}:`,
      driveRootRelative: false,
      segments: parsed.segments,
    }
  }
  const parsed = winSegments(input)
  if (!parsed.ok) return parsed
  const rooted = input.startsWith('\\')
  return {
    ok: true,
    prefix: rooted ? '' : undefined,
    driveRootRelative: rooted,
    segments: parsed.segments,
  }
}

/** 处理 `..`：回到上一级，不越过前缀。 */
function collapse(segments: readonly string[]): string[] {
  const out: string[] = []
  for (const s of segments) {
    if (s === '..') out.pop()
    else out.push(s)
  }
  return out
}

function join(style: PathStyle, prefix: string, segments: readonly string[]): string {
  if (style === 'posix') return `/${segments.join('/')}`
  return `${prefix}\\${segments.join('\\')}`
}

/**
 * 按路径文本把 `input` 解析为工作区内的路径（不访问文件系统）。
 * `root` 为工作区根目录的绝对路径。
 */
export function resolveWorkspacePathLexical(
  root: string,
  input: string,
  style: PathStyle,
): PathResolution {
  if (root.includes('\0') || input.includes('\0')) return fail(PathErrorCode.InvalidCharacter)
  if (input.trim() === '') return fail(PathErrorCode.Empty)
  const parse = style === 'posix' ? parsePosix : parseWin32

  const rootParsed = parse(root)
  if (!rootParsed.ok) return rootParsed
  if (rootParsed.prefix === undefined || rootParsed.driveRootRelative) {
    return fail(PathErrorCode.RootNotAbsolute)
  }
  const rootPrefix = rootParsed.prefix
  const rootSegments = collapse(rootParsed.segments)

  const parsed = parse(input)
  if (!parsed.ok) return parsed
  const prefix =
    parsed.prefix === undefined || parsed.driveRootRelative ? rootPrefix : parsed.prefix
  const segments = collapse(
    parsed.prefix === undefined ? [...rootSegments, ...parsed.segments] : parsed.segments,
  )

  const key = style === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
  const inside =
    key(prefix) === key(rootPrefix) &&
    segments.length >= rootSegments.length &&
    rootSegments.every((s, i) => key(s) === key(segments[i]!))
  if (!inside) return fail(PathErrorCode.OutsideWorkspace)

  const relative = segments.slice(rootSegments.length)
  return {
    ok: true,
    path: {
      absolute: join(style, rootPrefix, [...rootSegments, ...relative]),
      relative: relative.length === 0 ? '.' : relative.join('/'),
    },
  }
}
