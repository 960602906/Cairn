/**
 * 附件文字抽取（ADR-0052）：PDF、Excel、Word、PowerPoint 与文本类文件转成纯文字，附给模型。
 *
 * - 只在主进程做，内容是发送那一刻的快照，和 `@` 引用的展开一样写进 `message.user.context`。
 * - 单个文件最多 `ATTACHMENT_TEXT_MAX` 字符，一条消息最多 `ATTACHMENT_CONTEXT_MAX`。
 * - 解析失败、加密、格式不支持时返回 undefined，由调用方附一句“内容无法抽取”，不影响发送。
 * - Excel 只读 `.xlsx`（OOXML，用已有的 fflate 解压），旧的 `.xls` 二进制格式不支持；
 *   日期按单元格样式转换，其余按缓存值输出，多个工作表逐个列出。
 * - PDF 用 unpdf（pdf.js）取文本，最多前 50 页。
 */
import { decodeFile } from '@cairn/tools'
import { strFromU8, unzipSync } from 'fflate'
import { getDocumentProxy } from 'unpdf'

/** 单个附件最多抽取多少字符。 */
export const ATTACHMENT_TEXT_MAX = 32 * 1024
/** 一条消息的附件文字总量上限。 */
export const ATTACHMENT_CONTEXT_MAX = 96 * 1024

export interface AttachmentTextInput {
  readonly name: string
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/** 按名称与类型抽取附件文字；没有可给模型看的内容时返回 undefined。 */
export async function attachmentText(file: AttachmentTextInput): Promise<string | undefined> {
  const extension = extensionOf(file.name)
  try {
    if (extension === 'pdf' || file.mimeType === 'application/pdf') {
      return clip(await pdfText(file.bytes))
    }
    if (extension === 'xlsx' || extension === 'xlsm' || file.mimeType.includes('spreadsheetml')) {
      return clip(xlsxText(file.bytes))
    }
    if (extension === 'docx') return clip(docxText(file.bytes))
    if (extension === 'pptx') return clip(pptxText(file.bytes))
    if (isTextLike(extension, file.mimeType)) return clip(textOf(file.bytes))
  } catch {
    return undefined
  }
  return undefined
}

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length > ATTACHMENT_TEXT_MAX
    ? `${trimmed.slice(0, ATTACHMENT_TEXT_MAX)}\n[Content truncated]`
    : trimmed
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'mdx',
  'rst',
  'adoc',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'cs',
  'php',
  'lua',
  'pl',
  'r',
  'm',
  'mm',
  'scala',
  'dart',
  'ex',
  'exs',
  'erl',
  'hrl',
  'hs',
  'clj',
  'cljs',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'graphql',
  'gql',
  'proto',
  'tex',
  'bib',
  'diff',
  'patch',
])

function isTextLike(extension: string, mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    TEXT_EXTENSIONS.has(extension) ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  )
}

/** 文本文件：按与 `read_file` 相同的规则解码；二进制内容不抽取。 */
function textOf(bytes: Uint8Array): string | undefined {
  const decoded = decodeFile(bytes)
  return decoded.binary ? undefined : decoded.text
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function pdfText(bytes: Uint8Array): Promise<string | undefined> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  try {
    const pages = Math.min(pdf.numPages, 50)
    const parts: string[] = []
    let length = 0
    for (let number = 1; number <= pages; number++) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
      parts.push(text)
      length += text.length
      if (length >= ATTACHMENT_TEXT_MAX) break
    }
    return parts.join('\n\n')
  } finally {
    await pdf.cleanup()
  }
}

// ---------------------------------------------------------------------------
// Excel（.xlsx / .xlsm）
// ---------------------------------------------------------------------------

interface SheetRef {
  readonly name: string
  readonly path: string
}

const MAX_SHEETS = 8
const MAX_ROWS = 200
const MAX_COLUMNS = 50

/** 单个 OOXML 条目解压后的上限；压缩包可以很小却展开得很大。 */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
/** 一次解压所有条目的总量上限。 */
const MAX_UNZIP_BYTES = 64 * 1024 * 1024

/** 解压 OOXML，但跳过异常大的条目，避免压缩炸弹把内存撑爆。 */
function unzipCapped(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0
  return unzipSync(bytes, {
    filter: (file) => {
      if (file.originalSize > MAX_ENTRY_BYTES) return false
      total += file.originalSize
      return total <= MAX_UNZIP_BYTES
    },
  })
}

function xlsxText(bytes: Uint8Array): string | undefined {
  const files = unzipCapped(bytes)
  const shared = sharedStrings(textFile(files, 'xl/sharedStrings.xml'))
  const dates = dateStyles(files)
  const sheets = workbookSheets(files)
  const parts: string[] = []
  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    const xml = textFile(files, sheet.path)
    if (xml === undefined) continue
    const rows = sheetRows(xml, shared, dates)
    if (rows.length === 0) continue
    parts.push(`## ${sheet.name}\n${rows.join('\n')}`)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function textFile(files: Record<string, Uint8Array>, path: string): string | undefined {
  const bytes = files[path]
  return bytes === undefined ? undefined : strFromU8(bytes)
}

/** 解析一段 XML 属性；值做实体反转义。 */
function attrsOf(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    // 捕获组只要匹配上就是字符串，`?? ''` 只是安抚类型系统。
    attrs[match[1]!] = unescapeXml(match[2]!)
  }
  return attrs
}

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) =>
      codePoint(whole, Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (whole, dec: string) => codePoint(whole, Number(dec)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function codePoint(whole: string, value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : whole
}

function sharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => unescapeXml(text[1]!))
      .join(''),
  )
}

function workbookSheets(files: Record<string, Uint8Array>): SheetRef[] {
  const workbook = textFile(files, 'xl/workbook.xml')
  if (workbook === undefined) return []
  const rels = textFile(files, 'xl/_rels/workbook.xml.rels') ?? ''
  const targets = new Map<string, string>()
  for (const match of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = attrsOf(match[1]!)
    if (attrs.Id !== undefined && attrs.Target !== undefined) targets.set(attrs.Id, attrs.Target)
  }
  const sheets: SheetRef[] = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = attrsOf(match[1]!)
    const target = attrs['r:id'] === undefined ? undefined : targets.get(attrs['r:id'])
    if (target === undefined) continue
    sheets.push({
      name: attrs.name ?? `Sheet${sheets.length + 1}`,
      path: target.startsWith('/') ? target.slice(1) : `xl/${target}`,
    })
  }
  return sheets
}

/** 单元格样式是不是日期格式（内置编号与自定义格式）。 */
function dateStyles(files: Record<string, Uint8Array>): boolean[] {
  const xml = textFile(files, 'xl/styles.xml')
  if (xml === undefined) return []
  const custom = new Map<number, string>()
  for (const match of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const attrs = attrsOf(match[1]!)
    const id = Number(attrs.numFmtId)
    if (Number.isInteger(id) && attrs.formatCode !== undefined) custom.set(id, attrs.formatCode)
  }
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? ''
  return [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((match) => {
    const id = Number(attrsOf(match[1]!).numFmtId ?? '0')
    return isDateNumberFormat(id, custom.get(id))
  })
}

function isDateNumberFormat(id: number, formatCode: string | undefined): boolean {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47)) return true
  if (formatCode === undefined) return false
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .toLowerCase()
  return /[ymdhs]/.test(cleaned) && !/[0#?]/.test(cleaned)
}

/** Excel 序列日期（1899-12-30 起的天数）转 ISO；只保留日期或日期时间。 */
function excelDate(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial < 0) return undefined
  const date = new Date(Math.round((serial - 25569) * 86_400_000))
  if (Number.isNaN(date.getTime())) return undefined
  const iso = date.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

function sheetRows(xml: string, shared: readonly string[], dates: readonly boolean[]): string[] {
  const rows: string[] = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS) {
      rows.push('[More rows omitted]')
      break
    }
    const cells: string[] = []
    let next = 0
    for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attrsOf(cellMatch[1]!)
      const index = attrs.r === undefined ? next : columnIndex(attrs.r)
      if (index < MAX_COLUMNS) {
        while (cells.length < index) cells.push('')
        cells[index] = cellValue(attrs, cellMatch[2] ?? '', shared, dates)
      }
      next = index + 1
    }
    const line = cells.join('\t')
    if (line.replaceAll('\t', '') !== '') rows.push(line)
  }
  return rows
}

function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1] ?? 'A'
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

function cellValue(
  attrs: Record<string, string>,
  body: string,
  shared: readonly string[],
  dates: readonly boolean[],
): string {
  const type = attrs.t
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => unescapeXml(match[1]!))
      .join('')
  }
  const value = unescapeXml(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
  if (type === 's') return shared[Number(value)] ?? ''
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  if (type === 'str' || type === 'e') return value
  if (value === '') return ''
  if (attrs.s !== undefined && dates[Number(attrs.s)] === true) {
    const date = excelDate(Number(value))
    if (date !== undefined) return date
  }
  return value
}

// ---------------------------------------------------------------------------
// Word / PowerPoint（OOXML）
// ---------------------------------------------------------------------------

function docxText(bytes: Uint8Array): string | undefined {
  const xml = textFile(unzipCapped(bytes), 'word/document.xml')
  if (xml === undefined) return undefined
  const marked = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
  return unescapeXml(marked.replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n')
}

function pptxText(bytes: Uint8Array): string | undefined {
  const files = unzipCapped(bytes)
  const slides = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const parts: string[] = []
  for (const path of slides) {
    // 路径来自 files 的键，这里一定读得到。
    const xml = textFile(files, path)!
    const text = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((match) => unescapeXml(match[1]!))
      .join('\n')
    if (text.trim() !== '') parts.push(`## Slide ${slideNumber(path)}\n${text}`)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function slideNumber(path: string): number {
  // 调用方已经按 `slide\d+\.xml` 过滤过。
  return Number(/slide(\d+)\.xml$/.exec(path)![1])
}
