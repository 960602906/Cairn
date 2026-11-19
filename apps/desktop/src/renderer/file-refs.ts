/**
 * 助手正文里的文件引用：`AutofixSettings.tsx`、`src/renderer/app.tsx:12`、`logo.png`。
 *
 * 只负责“看起来像文件”的识别（纯函数，不动文字）；是否真的存在由主进程确认
 * （`fs.exists`，裸文件名按项目文件列表解析），确认后才在界面里变成可点的路径。
 *
 * 规则：
 * - 路径段只用 ASCII 的文件名字符；中文、全角标点、空白都算边界，引用后面紧跟中文也不会吞进去；
 * - 最后一段必须带一个已知扩展名（或 `Dockerfile` 这类常见无扩展名文件）；
 * - 可以带 `:行号` 或 `:起始-结束`；
 * - 网址、绝对路径、`.` 与 `..` 段、代码块里的内容都不算。
 */
import { tokenize } from './composer-tokens.js'

export interface FileRef {
  readonly path: string
  readonly line?: number
}

/** 认作文件引用的扩展名（小写，不含点）。 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // 代码
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'astro',
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
  'hh',
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
  // 标记与样式
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'styl',
  'md',
  'mdx',
  'markdown',
  'txt',
  'rst',
  'adoc',
  'tex',
  'svg',
  'xml',
  'xsl',
  'xslt',
  // 数据与配置
  'json',
  'jsonc',
  'json5',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
  'lock',
  'csv',
  'tsv',
  'sql',
  'graphql',
  'gql',
  'proto',
  'tf',
  'tfvars',
  'hcl',
  'nix',
  'ipynb',
  'map',
  'log',
  'diff',
  'patch',
  // 图片与其他二进制
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'heic',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'rar',
  '7z',
  'wasm',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'mov',
  'db',
  'sqlite',
  'sqlite3',
])

/** 常见、没有扩展名的文件。 */
const KNOWN_NAMES: ReadonlySet<string> = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Vagrantfile',
  'Justfile',
])

const MAX_PATH_LENGTH = 4096
/** 一条消息里最多确认多少个引用，和主进程的 `fs.exists` 上限一致。 */
const MAX_CANDIDATES = 200

/** 一个路径段里允许的字符。 */
const SEGMENT = '[A-Za-z0-9_.@+#$-]+'
const PATH_ONLY = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`)
/** 正文里扫引用：前面不能紧挨路径字符（网址、更长的路径的一部分不算）。 */
const SCAN = new RegExp(`(?<![\\w./:@#$+-])${SEGMENT}(?:/${SEGMENT})*(?::\\d+(?:-\\d+)?)?`, 'g')
const LINE_SUFFIX = /:(\d+)(?:-\d+)?$/

/** 最后一段是不是一个像样的文件名。 */
function looksLikeFile(filePath: string): boolean {
  if (filePath.length === 0 || filePath.length > MAX_PATH_LENGTH) return false
  const parts = filePath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  const name = parts.at(-1) as string
  if (KNOWN_NAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * 解析一个完整的文件名引用（整个字符串就是路径，可以带行号）。
 * 不是文件引用时返回 undefined。
 */
export function parseFileRef(raw: string): FileRef | undefined {
  const text = raw.trim()
  if (text === '' || text.length > MAX_PATH_LENGTH || text.includes('://')) return undefined
  const suffix = LINE_SUFFIX.exec(text)
  const filePath = suffix === null ? text : text.slice(0, suffix.index)
  if (suffix !== null && Number(suffix[1]) < 1) return undefined
  if (!PATH_ONLY.test(filePath) || !looksLikeFile(filePath)) return undefined
  return suffix === null ? { path: filePath } : { path: filePath, line: Number(suffix[1]) }
}

/**
 * 在一段普通文字里找文件引用。返回的位置是原文下标，按出现顺序排列。
 * 末尾当作句读的点会被去掉。
 */
export function fileRefsInText(
  text: string,
): { readonly ref: FileRef; readonly start: number; readonly end: number }[] {
  const refs: { ref: FileRef; start: number; end: number }[] = []
  for (const match of text.matchAll(SCAN)) {
    const raw = match[0].replace(/\.+$/, '')
    const ref = parseFileRef(raw)
    if (ref === undefined) continue
    refs.push({ ref, start: match.index, end: match.index + raw.length })
  }
  return refs
}

/**
 * 一段 Markdown 里需要确认是否存在的文件引用（正文与行内代码，不含代码块），去重，
 * 最多 {@link MAX_CANDIDATES} 个。
 */
export function fileRefCandidates(text: string): string[] {
  const paths = new Set<string>()
  const add = (ref: FileRef | undefined) => {
    if (ref !== undefined && !paths.has(ref.path) && paths.size < MAX_CANDIDATES) {
      paths.add(ref.path)
    }
  }
  for (const token of tokenize(text)) {
    if (token.type === 'code') {
      if (!token.text.startsWith('```')) add(parseFileRef(token.text.slice(1, -1)))
    } else if (token.type === 'text') {
      for (const { ref } of fileRefsInText(token.text)) add(ref)
    }
  }
  return [...paths]
}
