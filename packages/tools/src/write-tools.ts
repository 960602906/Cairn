/**
 * 写类工具（M1-08a；架构 §9.2，Runtime §7）：`write_file` 新建或覆盖文件，`edit_file` 基于原文片段精确替换。
 *
 * - 保持原文件的编码（UTF-8、带 BOM 的 UTF-8、UTF-16 LE/BE）与换行风格（LF、CRLF、CR）。
 * - 审批前（`describeForApproval`）读取原文并计算 diff 作为预览，同时记下原文的指纹；审批后执行时
 *   重新读取，原文已变化则返回错误，让模型重新读取，避免覆盖用户在审批期间的修改。
 * - 改动记录（blob 存储、`file.changed`）在 M1-08b 接入；`planWrite` / `planEdit` 给出改动前后的内容。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { ToolError, type ApprovalPreview, type ToolContext, type ToolDefinition } from '@nexus/core'
import { createTwoFilesPatch } from 'diff'
import { resolveOrThrow } from './paths.js'
import {
  decodeFile,
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_OUTPUT_CHARS,
  splitLines,
} from './read-file.js'

export interface WriteFileInput {
  readonly path: string
  readonly content: string
}

export interface EditFileInput {
  readonly path: string
  /** 要替换的原文片段，必须与文件内容完全一致（包括缩进）。 */
  readonly oldText: string
  readonly newText: string
  /** 替换全部出现的位置；默认只允许唯一的一处。 */
  readonly replaceAll?: boolean
}

export const WriteFileErrorCode = {
  IsDirectory: 'tool.write_file.is_directory',
  TooLarge: 'tool.write_file.too_large',
  ChangedSincePreview: 'tool.write_file.changed_since_preview',
  Failed: 'tool.write_file.failed',
} as const

export const EditFileErrorCode = {
  NotFound: 'tool.edit_file.not_found',
  IsDirectory: 'tool.edit_file.is_directory',
  TooLarge: 'tool.edit_file.too_large',
  Binary: 'tool.edit_file.binary',
  UnsupportedEncoding: 'tool.edit_file.unsupported_encoding',
  NoMatch: 'tool.edit_file.no_match',
  Ambiguous: 'tool.edit_file.ambiguous',
  NoChange: 'tool.edit_file.no_change',
  ChangedSincePreview: 'tool.edit_file.changed_since_preview',
  Failed: 'tool.edit_file.failed',
} as const

/** 可写入的文件大小上限（与 `read_file` 相同）。 */
export const WRITE_FILE_MAX_BYTES = READ_FILE_MAX_BYTES
/** 歧义时最多列出的行号数。 */
const MAX_LISTED_MATCHES = 10

type Encoding = 'UTF-8' | 'UTF-8 with BOM' | 'UTF-16 LE' | 'UTF-16 BE'
type LineEnding = 'LF' | 'CRLF' | 'CR'

/** 按编码写出文本（带相应的 BOM）。 */
export function encodeText(text: string, encoding: Encoding): Buffer {
  switch (encoding) {
    case 'UTF-8':
      return Buffer.from(text, 'utf8')
    case 'UTF-8 with BOM':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'UTF-16 LE':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'UTF-16 BE':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
  }
}

const EOL: Record<LineEnding, string> = { LF: '\n', CRLF: '\r\n', CR: '\r' }
const toLf = (text: string) => text.replace(/\r\n?/g, '\n')
/** 把文本的换行统一为指定风格。 */
export const withLineEnding = (text: string, eol: LineEnding) =>
  eol === 'LF' ? toLf(text) : toLf(text).replace(/\n/g, EOL[eol])

/** 一次写入的计划：改动前后的内容与预览。 */
export interface WritePlan {
  /** 相对工作区的路径（`/` 分隔）。 */
  readonly path: string
  readonly absolute: string
  /** 改动前的内容；文件不存在时为 undefined。 */
  readonly before: Buffer | undefined
  readonly after: Buffer
  /** 改动前后的文本（换行统一为 LF），用于 diff。 */
  readonly beforeText: string
  readonly afterText: string
  /** 写入时使用的编码与换行风格（沿用原文件）。 */
  readonly encoding: Encoding
  readonly lineEnding: LineEnding | 'mixed' | undefined
  /** 给模型的结果说明（不含 diff）。 */
  readonly message: string
}

/** 原文件的指纹：内容的 SHA-256，文件不存在时为 `absent`。 */
const fingerprint = (content: Buffer | undefined) =>
  content === undefined ? 'absent' : createHash('sha256').update(content).digest('hex')

const fsError = (error: unknown) => (error as NodeJS.ErrnoException).code

/** 读取文件；不存在时返回 undefined，是目录或过大时抛出相应的错误。 */
async function readExisting(
  absolute: string,
  relative: string,
  codes: { IsDirectory: string; TooLarge: string; Failed: string },
): Promise<Buffer | undefined> {
  try {
    const stat = await fs.stat(absolute)
    if (stat.isDirectory()) {
      throw new ToolError(codes.IsDirectory, `${relative} is a directory.`, { path: relative })
    }
    if (stat.size > WRITE_FILE_MAX_BYTES) {
      throw new ToolError(
        codes.TooLarge,
        `${relative} is too large to edit (${stat.size} bytes, limit ${WRITE_FILE_MAX_BYTES}).`,
        { path: relative, size: stat.size },
      )
    }
    return await fs.readFile(absolute)
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (fsError(error) === 'ENOENT') return undefined
    throw new ToolError(
      codes.Failed,
      `Cannot read ${relative} (${fsError(error) ?? 'unknown error'}).`,
      { path: relative },
    )
  }
}

const lineCount = (text: string) => splitLines(text).lines.length
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** 非默认的格式（带 BOM、UTF-16、CRLF、CR）在结果中说明，模型由此知道换行与编码已被保留。 */
function formatNote(encoding: Encoding, lineEnding: WritePlan['lineEnding']): string {
  const parts: string[] = []
  if (encoding !== 'UTF-8') parts.push(encoding)
  if (lineEnding === 'CRLF' || lineEnding === 'CR') parts.push(`${lineEnding} line endings`)
  return parts.length === 0 ? '' : ` Kept ${parts.join(', ')}.`
}

/** 计算 `write_file` 的结果，不写入。 */
export async function planWrite(input: WriteFileInput, ctx: ToolContext): Promise<WritePlan> {
  const path = await resolveOrThrow(ctx, input.path)
  const before = await readExisting(path.absolute, path.relative, WriteFileErrorCode)
  let encoding: Encoding = 'UTF-8'
  let lineEnding: WritePlan['lineEnding']
  let beforeText = ''
  let text = input.content
  if (before !== undefined) {
    const decoded = decodeFile(before)
    if (!decoded.binary) {
      // 非 UTF-8 的文件整体覆盖为 UTF-8
      if (!decoded.lossy) encoding = decoded.encoding
      beforeText = toLf(decoded.text)
      lineEnding = splitLines(decoded.text).lineEndings
      if (lineEnding !== undefined && lineEnding !== 'mixed') {
        text = withLineEnding(text, lineEnding)
      }
    }
  }
  const after = encodeText(text, encoding)
  if (after.length > WRITE_FILE_MAX_BYTES) {
    throw new ToolError(
      WriteFileErrorCode.TooLarge,
      `The content is too large to write (${after.length} bytes, limit ${WRITE_FILE_MAX_BYTES}).`,
      { path: path.relative, size: after.length },
    )
  }
  const lines = lineCount(input.content)
  const message =
    before === undefined
      ? `Created ${path.relative} (${plural(lines, 'line')}).`
      : `Overwrote ${path.relative} (${plural(lines, 'line')}, previously ${plural(lineCount(beforeText), 'line')}).${formatNote(encoding, lineEnding)}`
  return {
    path: path.relative,
    absolute: path.absolute,
    before,
    after,
    beforeText,
    afterText: toLf(input.content),
    encoding,
    lineEnding,
    message,
  }
}

/** 在 `text` 中找出 `search` 的全部位置（不重叠）。 */
function findAll(text: string, search: string): number[] {
  const found: number[] = []
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + search.length)) {
    found.push(i)
  }
  return found
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length

/** 忽略缩进与行尾空白时能否找到：返回起始行号。用于给模型更明确的失败原因。 */
function findLoosely(text: string, search: string): number | undefined {
  const lines = text.split('\n').map((l) => l.trim())
  const wanted = search.split('\n').map((l) => l.trim())
  while (wanted.length > 0 && wanted.at(-1) === '') wanted.pop()
  if (wanted.length === 0 || lines.length > 50_000) return undefined
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, k) => lines[i + k] === w)) return i + 1
  }
  return undefined
}

/** 计算 `edit_file` 的结果，不写入。 */
export async function planEdit(input: EditFileInput, ctx: ToolContext): Promise<WritePlan> {
  const path = await resolveOrThrow(ctx, input.path)
  const before = await readExisting(path.absolute, path.relative, EditFileErrorCode)
  if (before === undefined) {
    throw new ToolError(
      EditFileErrorCode.NotFound,
      `File not found: ${path.relative}. Use write_file to create a new file.`,
      { path: path.relative },
    )
  }
  const decoded = decodeFile(before)
  if (decoded.binary) {
    throw new ToolError(EditFileErrorCode.Binary, `${path.relative} is a binary file.`, {
      path: path.relative,
    })
  }
  if (decoded.lossy) {
    throw new ToolError(
      EditFileErrorCode.UnsupportedEncoding,
      `${path.relative} is not valid UTF-8 or UTF-16. Editing it would change bytes outside the edit, so it is not supported.`,
      { path: path.relative },
    )
  }
  if (input.oldText === input.newText) {
    throw new ToolError(EditFileErrorCode.NoChange, 'oldText and newText are the same.', {
      path: path.relative,
    })
  }

  const { lineEndings } = splitLines(decoded.text)
  // 统一换行风格的文件按 LF 匹配（read_file 显示的行不含 CR），写回时恢复原风格；混合风格的文件按原文匹配
  const mixed = lineEndings === 'mixed'
  const text = mixed ? decoded.text : toLf(decoded.text)
  const oldText = mixed ? input.oldText : toLf(input.oldText)
  const newText = mixed ? input.newText : toLf(input.newText)
  const found = findAll(text, oldText)
  if (found.length === 0) {
    const loose = mixed ? undefined : findLoosely(text, oldText)
    const hint =
      loose === undefined
        ? 'Read the file again and copy the exact text, including indentation.'
        : `A similar text with different indentation or trailing whitespace starts at line ${loose}. Read the file again and copy the exact text.`
    throw new ToolError(
      EditFileErrorCode.NoMatch,
      `oldText was not found in ${path.relative}. ${hint}${mixed ? ' The file has mixed line endings, so oldText must match them exactly.' : ''}`,
      { path: path.relative },
    )
  }
  if (found.length > 1 && !input.replaceAll) {
    const lines = found.slice(0, MAX_LISTED_MATCHES).map((i) => lineAt(text, i))
    throw new ToolError(
      EditFileErrorCode.Ambiguous,
      `oldText occurs ${found.length} times in ${path.relative} (lines ${lines.join(', ')}${found.length > MAX_LISTED_MATCHES ? ', …' : ''}). Include more surrounding lines to make it unique, or set replaceAll to replace every occurrence.`,
      { path: path.relative, count: found.length },
    )
  }
  const edited = text.split(oldText).join(newText)
  const output = mixed || lineEndings === undefined ? edited : withLineEnding(edited, lineEndings)
  const after = encodeText(output, decoded.encoding)
  const where = found.length === 1 ? ` at line ${lineAt(text, found[0]!)}` : ''
  return {
    path: path.relative,
    absolute: path.absolute,
    before,
    after,
    beforeText: toLf(decoded.text),
    afterText: toLf(output),
    encoding: decoded.encoding,
    lineEnding: lineEndings,
    message: `Edited ${path.relative}: replaced ${plural(found.length, 'occurrence')}${where}.${formatNote(decoded.encoding, lineEndings)}`,
  }
}

/** 计算 diff 的时间上限（毫秒）。整个文件大幅改写时逐行比较可能很慢，超时后改用简化的 diff。 */
export const DIFF_TIMEOUT_MS = 1000
const DIFF_CONTEXT = 3

/**
 * 统一 diff（文件名带 `a/`、`b/` 前缀；新建文件的原文件为 `/dev/null`）。输入的换行为 LF。
 * 超过 `timeoutMs` 时改用简化的 diff：去掉首尾相同的行，中间部分整体作为删除与新增。
 */
export function unifiedDiff(
  oldName: string,
  newName: string,
  before: string,
  after: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): string {
  const patch =
    timeoutMs > 0
      ? createTwoFilesPatch(oldName, newName, before, after, undefined, undefined, {
          context: DIFF_CONTEXT,
          timeout: timeoutMs,
        })
      : undefined
  if (patch === undefined) return simpleDiff(oldName, newName, before, after)
  // 去掉 jsdiff 可能输出的 `Index:` 与 `===` 行
  const lines = patch.split('\n')
  while (lines.length > 0 && !lines[0]!.startsWith('--- ')) lines.shift()
  return lines.join('\n').trimEnd()
}

const toLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

/** 简化的 diff：一个块，首尾相同的行作为上下文。时间与文件长度成正比。 */
function simpleDiff(oldName: string, newName: string, before: string, after: string): string {
  const a = toLines(before)
  const b = toLines(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }
  const start = Math.max(0, prefix - DIFF_CONTEXT)
  const pre = a.slice(start, prefix)
  const removed = a.slice(prefix, a.length - suffix)
  const added = b.slice(prefix, b.length - suffix)
  const post = a.slice(a.length - suffix, a.length - suffix + DIFF_CONTEXT)
  const oldCount = pre.length + removed.length + post.length
  const newCount = pre.length + added.length + post.length
  const range = (count: number) => `${count === 0 ? start : start + 1},${count}`
  return [
    `--- ${oldName}`,
    `+++ ${newName}`,
    `@@ -${range(oldCount)} +${range(newCount)} @@`,
    ...pre.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...post.map((l) => ` ${l}`),
  ].join('\n')
}

/** 一次写入计划的 diff。 */
export function planDiff(plan: WritePlan): string {
  return unifiedDiff(
    plan.before === undefined ? '/dev/null' : `a/${plan.path}`,
    `b/${plan.path}`,
    plan.beforeText,
    plan.afterText,
  )
}

/** diff 中新增与删除的行数。 */
function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

function preview(plan: WritePlan, verb: string): ApprovalPreview {
  const diff = planDiff(plan)
  const { added, removed } = diffStat(diff)
  return { summary: `${verb} ${plan.path} (+${added} -${removed})`, diff }
}

/** 审批前记下的原文指纹，按工具调用 id 保存，执行时取出。数量有上限，被拒绝的调用不会一直占用。 */
class PreviewFingerprints {
  readonly #map = new Map<string, string>()
  set(toolCallId: string, value: string): void {
    this.#map.delete(toolCallId)
    this.#map.set(toolCallId, value)
    if (this.#map.size > 256) this.#map.delete(this.#map.keys().next().value!)
  }
  take(toolCallId: string): string | undefined {
    const value = this.#map.get(toolCallId)
    this.#map.delete(toolCallId)
    return value
  }
}

/** 审批后执行前：原文与预览时不一致则抛出（在重新计算改动之前检查，原因更明确）。 */
async function assertUnchanged(
  input: { path: string },
  expected: string | undefined,
  ctx: ToolContext,
  codes: { ChangedSincePreview: string; Failed: string },
): Promise<void> {
  if (expected === undefined) return
  const path = await resolveOrThrow(ctx, input.path)
  let current: Buffer | undefined
  try {
    current = await fs.readFile(path.absolute)
  } catch (error) {
    // 不存在、变成目录等情况都按“已变化”处理（指纹为 absent）
    if (fsError(error) !== 'ENOENT' && fsError(error) !== 'EISDIR') {
      throw new ToolError(
        codes.Failed,
        `Cannot read ${path.relative} (${fsError(error) ?? 'unknown error'}).`,
        { path: path.relative },
      )
    }
  }
  if (fingerprint(current) !== expected) {
    throw new ToolError(
      codes.ChangedSincePreview,
      `${path.relative} was changed after the change was shown for approval, so it was not written. Read the file again and redo the change.`,
      { path: path.relative },
    )
  }
}

async function commit(plan: WritePlan, ctx: ToolContext, codes: { Failed: string }): Promise<void> {
  if (ctx.signal.aborted) return
  try {
    if (plan.before === undefined) {
      await fs.mkdir(nodePath.dirname(plan.absolute), { recursive: true })
    }
    await fs.writeFile(plan.absolute, plan.after)
  } catch (error) {
    throw new ToolError(
      codes.Failed,
      `Cannot write ${plan.path} (${fsError(error) ?? 'unknown error'}).`,
      { path: plan.path },
    )
  }
}

const normalizePath = async <I extends { path: string }>(input: I, ctx: ToolContext) => {
  const path = await resolveOrThrow(ctx, input.path)
  return { input: { ...input, path: path.relative }, targets: { paths: [path.relative] } }
}

/** 创建 `write_file` 工具。每个实例各自保存审批前的指纹。 */
export function createWriteFileTool(): ToolDefinition<WriteFileInput> {
  const fingerprints = new PreviewFingerprints()
  return {
    name: 'write_file',
    description:
      'Create a new file or overwrite an existing file in the workspace with the given content. ' +
      'Parent directories are created as needed. When overwriting, the file keeps its encoding ' +
      '(including BOM) and line ending style. Prefer edit_file to change part of an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace root.' },
        content: { type: 'string', description: 'The complete new content of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    category: 'write',
    source: { kind: 'builtin' },
    trust: 'builtin',
    normalize: normalizePath,

    async describeForApproval(input, ctx) {
      const plan = await planWrite(input, ctx)
      fingerprints.set(ctx.toolCallId, fingerprint(plan.before))
      return preview(plan, plan.before === undefined ? 'Create' : 'Overwrite')
    },

    async execute(input, ctx) {
      await assertUnchanged(input, fingerprints.take(ctx.toolCallId), ctx, WriteFileErrorCode)
      const plan = await planWrite(input, ctx)
      await commit(plan, ctx, WriteFileErrorCode)
      return { content: [{ type: 'text', text: plan.message }] }
    },
  }
}

/** 创建 `edit_file` 工具。每个实例各自保存审批前的指纹。 */
export function createEditFileTool(): ToolDefinition<EditFileInput> {
  const fingerprints = new PreviewFingerprints()
  return {
    name: 'edit_file',
    description:
      'Replace an exact piece of text in an existing file. oldText must match the file exactly ' +
      '(including indentation) and occur exactly once, unless replaceAll is true; include enough ' +
      'surrounding lines to make it unique. Line numbers from read_file are not part of the text. ' +
      'The file keeps its encoding and line ending style. Returns a diff of the change.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace root.' },
        oldText: {
          type: 'string',
          minLength: 1,
          description: 'The exact text to replace.',
        },
        newText: { type: 'string', description: 'The text to replace it with.' },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence of oldText. Default false.',
        },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    category: 'write',
    source: { kind: 'builtin' },
    trust: 'builtin',
    normalize: normalizePath,

    async describeForApproval(input, ctx) {
      const plan = await planEdit(input, ctx)
      fingerprints.set(ctx.toolCallId, fingerprint(plan.before))
      return preview(plan, 'Edit')
    },

    async execute(input, ctx) {
      await assertUnchanged(input, fingerprints.take(ctx.toolCallId), ctx, EditFileErrorCode)
      const plan = await planEdit(input, ctx)
      await commit(plan, ctx, EditFileErrorCode)
      let diff = planDiff(plan)
      if (diff.length > READ_FILE_MAX_OUTPUT_CHARS) {
        diff = `${diff.slice(0, READ_FILE_MAX_OUTPUT_CHARS)}\n[Diff truncated. Use read_file to check the result.]`
      }
      return { content: [{ type: 'text', text: `${plan.message}\n${diff}` }] }
    },
  }
}
