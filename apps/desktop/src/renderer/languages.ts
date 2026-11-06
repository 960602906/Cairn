/**
 * 代码卡片支持高亮的语言（M2-06）：Markdown 代码块的语言名与文件扩展名都映射到 Shiki 的语言 id，
 * 并给出语言图标的缩写与颜色（`--tk-*` 令牌）。不在表里的语言按纯文本显示。
 */
import type { LanguageRegistration } from '@shikijs/core'

type Loader = () => Promise<{ default: LanguageRegistration[] }>

export interface LanguageInfo {
  /** Shiki 的语言 id。 */
  readonly id: string
  /** 语言图标里的缩写。 */
  readonly label: string
  /** 语言图标的颜色令牌。 */
  readonly tone: string
  readonly load: Loader
}

const languages = {
  typescript: {
    label: 'TS',
    tone: '--tk-f',
    names: ['ts', 'mts', 'cts'],
    load: () => import('@shikijs/langs/typescript'),
  },
  tsx: { label: 'TSX', tone: '--tk-f', names: [], load: () => import('@shikijs/langs/tsx') },
  javascript: {
    label: 'JS',
    tone: '--tk-n',
    names: ['js', 'mjs', 'cjs'],
    load: () => import('@shikijs/langs/javascript'),
  },
  jsx: { label: 'JSX', tone: '--tk-n', names: [], load: () => import('@shikijs/langs/jsx') },
  json: {
    label: '{}',
    tone: '--tk-pr',
    names: ['json5'],
    load: () => import('@shikijs/langs/json'),
  },
  jsonc: { label: '{}', tone: '--tk-pr', names: [], load: () => import('@shikijs/langs/jsonc') },
  python: {
    label: 'PY',
    tone: '--tk-t',
    names: ['py', 'pyw', 'pyi'],
    load: () => import('@shikijs/langs/python'),
  },
  shellscript: {
    label: 'SH',
    tone: '--tk-s',
    names: ['sh', 'bash', 'zsh', 'shell', 'console'],
    load: () => import('@shikijs/langs/shellscript'),
  },
  powershell: {
    label: 'PS',
    tone: '--tk-f',
    names: ['ps1', 'psm1', 'psd1', 'pwsh', 'ps'],
    load: () => import('@shikijs/langs/powershell'),
  },
  css: { label: 'CSS', tone: '--tk-k', names: [], load: () => import('@shikijs/langs/css') },
  html: {
    label: '<>',
    tone: '--tk-n',
    names: ['htm'],
    load: () => import('@shikijs/langs/html'),
  },
  markdown: {
    label: 'MD',
    tone: '--tk-c',
    names: ['md', 'mdx'],
    load: () => import('@shikijs/langs/markdown'),
  },
  yaml: { label: 'YML', tone: '--tk-t', names: ['yml'], load: () => import('@shikijs/langs/yaml') },
  toml: { label: 'TML', tone: '--tk-t', names: [], load: () => import('@shikijs/langs/toml') },
  rust: { label: 'RS', tone: '--tk-n', names: ['rs'], load: () => import('@shikijs/langs/rust') },
  go: { label: 'GO', tone: '--tk-t', names: ['golang'], load: () => import('@shikijs/langs/go') },
  java: { label: 'JV', tone: '--tk-n', names: [], load: () => import('@shikijs/langs/java') },
  c: { label: 'C', tone: '--tk-f', names: ['h'], load: () => import('@shikijs/langs/c') },
  cpp: {
    label: 'C++',
    tone: '--tk-f',
    names: ['cc', 'cxx', 'hpp', 'hh', 'hxx', 'c++'],
    load: () => import('@shikijs/langs/cpp'),
  },
  csharp: {
    label: 'C#',
    tone: '--tk-k',
    names: ['cs', 'c#'],
    load: () => import('@shikijs/langs/csharp'),
  },
  sql: { label: 'SQL', tone: '--tk-s', names: [], load: () => import('@shikijs/langs/sql') },
  diff: {
    label: '±',
    tone: '--tk-s',
    names: ['patch'],
    load: () => import('@shikijs/langs/diff'),
  },
} satisfies Record<string, { label: string; tone: string; names: string[]; load: Loader }>

const byName = new Map<string, LanguageInfo>()
for (const [id, { label, tone, names, load }] of Object.entries(languages)) {
  const info: LanguageInfo = { id, label, tone, load }
  for (const name of [id, ...names]) byName.set(name, info)
}

/** 按语言名（Markdown 代码块的 info string，不区分大小写）查找。 */
export function languageByName(name: string | undefined): LanguageInfo | undefined {
  return name ? byName.get(name.trim().toLowerCase()) : undefined
}

/** 按文件路径的扩展名查找。 */
export function languageForPath(path: string): LanguageInfo | undefined {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? languageByName(base.slice(dot + 1)) : undefined
}
