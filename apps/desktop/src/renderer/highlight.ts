/**
 * 语法高亮（M2-06，视觉规范 §7.1）：Shiki 细粒度用法，JavaScript 正则引擎（不用 WASM），语言按需加载。
 * 主题的颜色全部是 `var(--tk-*)`，浅色 / 深色由令牌切换，同一份结果两套主题通用。
 * 高亮结果按（语言、代码）缓存；代码过长时不高亮。
 */
import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemeRegistration,
  type ThemedToken,
} from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { useEffect, useState } from 'react'
import type { LanguageInfo } from './languages.js'

export const THEME_NAME = 'cairn'
/** 超过这么多字符不高亮（tokenize 是同步的，太长会卡住界面）。 */
export const HIGHLIGHT_MAX_CHARS = 200_000
const CACHE_SIZE = 64

const tk = (name: string) => `var(--tk-${name})`

/** 按规范 §3 的九种令牌着色；更具体的作用域优先。 */
export const cairnTheme: ThemeRegistration = {
  name: THEME_NAME,
  type: 'light',
  colors: { 'editor.foreground': tk('v'), 'editor.background': 'var(--code-bg)' },
  fg: tk('v'),
  bg: 'var(--code-bg)',
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: tk('c'), fontStyle: 'italic' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator', 'meta.separator'],
      settings: { foreground: tk('p') },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
        'keyword.operator.word',
        'entity.name.tag',
        'variable.language',
      ],
      settings: { foreground: tk('k') },
    },
    {
      scope: [
        'string',
        'string.template',
        'punctuation.definition.string',
        'markup.inline.raw',
        'markup.fenced_code',
      ],
      settings: { foreground: tk('s') },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
      settings: { foreground: tk('n') },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
        'entity.name.section',
        'markup.heading',
      ],
      settings: { foreground: tk('f') },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'storage.type.primitive',
        'storage.type.built-in',
        'support.type.primitive',
      ],
      settings: { foreground: tk('t') },
    },
    {
      scope: [
        'variable.other.property',
        'variable.other.object.property',
        'meta.object-literal.key',
        'support.type.property-name',
        'entity.other.attribute-name',
        'entity.name.tag.yaml',
        'support.variable.property',
      ],
      settings: { foreground: tk('pr') },
    },
    {
      scope: ['variable', 'variable.parameter', 'variable.other.readwrite'],
      settings: { foreground: tk('v') },
    },
    { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
    { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
    { scope: 'markup.inserted', settings: { foreground: 'var(--add-fg)' } },
    { scope: 'markup.deleted', settings: { foreground: 'var(--del-fg)' } },
  ],
}

export interface HighlightToken {
  readonly content: string
  /** `var(--tk-*)`；没有时用默认文字颜色。 */
  readonly color?: string
  readonly italic?: true
  readonly bold?: true
}

export type HighlightedLines = readonly (readonly HighlightToken[])[]

let highlighter: Promise<HighlighterCore> | undefined
const loading = new Map<string, Promise<void>>()
const cache = new Map<string, HighlightedLines>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [cairnTheme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighter
}

async function ensureLanguage(core: HighlighterCore, language: LanguageInfo): Promise<void> {
  if (core.getLoadedLanguages().includes(language.id)) return
  let pending = loading.get(language.id)
  if (!pending) {
    pending = language.load().then((mod) => core.loadLanguage(mod.default))
    loading.set(language.id, pending)
  }
  await pending
}

const toToken = (token: ThemedToken): HighlightToken => {
  const style = token.fontStyle ?? 0
  return {
    content: token.content,
    ...(token.color ? { color: token.color } : {}),
    ...(style & 1 ? { italic: true as const } : {}),
    ...(style & 2 ? { bold: true as const } : {}),
  }
}

/** 已经高亮过的结果（同步读取缓存）。 */
export function cachedHighlight(
  code: string,
  language: LanguageInfo,
): HighlightedLines | undefined {
  return cache.get(`${language.id}\0${code}`)
}

/** 高亮一段代码，按行返回。语言加载失败或代码过长时返回 undefined（按纯文本显示）。 */
export async function highlight(
  code: string,
  language: LanguageInfo,
): Promise<HighlightedLines | undefined> {
  if (code.length > HIGHLIGHT_MAX_CHARS) return undefined
  const key = `${language.id}\0${code}`
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const core = await getHighlighter()
    await ensureLanguage(core, language)
    const lines = core
      .codeToTokensBase(code, { lang: language.id, theme: THEME_NAME })
      .map((line) => line.map(toToken))
    cache.set(key, lines)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
    return lines
  } catch {
    return undefined
  }
}

/** 高亮结果；还没好（或不高亮）时是 undefined，调用方先显示纯文本。 */
export function useHighlight(
  code: string,
  language: LanguageInfo | undefined,
): HighlightedLines | undefined {
  const cached = language ? cachedHighlight(code, language) : undefined
  const [result, setResult] = useState<{ key: string; lines: HighlightedLines } | undefined>()
  const key = language ? `${language.id}\0${code}` : ''
  useEffect(() => {
    if (!language || cached) return
    let alive = true
    void highlight(code, language).then((lines) => {
      if (alive && lines) setResult({ key, lines })
    })
    return () => {
      alive = false
    }
  }, [code, language, cached, key])
  if (cached) return cached
  return result?.key === key ? result.lines : undefined
}
