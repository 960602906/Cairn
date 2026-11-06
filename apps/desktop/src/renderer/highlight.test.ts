import { describe, expect, it } from 'vitest'
import { cachedHighlight, highlight, HIGHLIGHT_MAX_CHARS } from './highlight.js'
import { languageByName, languageForPath, type LanguageInfo } from './languages.js'

const ts = languageByName('ts')!

describe('languages', () => {
  it.each([
    ['ts', 'typescript'],
    ['TypeScript', 'typescript'],
    [' py ', 'python'],
    ['bash', 'shellscript'],
    ['pwsh', 'powershell'],
    ['c#', 'csharp'],
    ['yml', 'yaml'],
  ])('语言名 %s → %s', (name, id) => {
    expect(languageByName(name)?.id).toBe(id)
  })

  it('未知语言与空值', () => {
    expect(languageByName('brainfuck')).toBeUndefined()
    expect(languageByName(undefined)).toBeUndefined()
    expect(languageByName('')).toBeUndefined()
  })

  it.each([
    ['src/a.ts', 'typescript'],
    ['C:\\code\\app.TSX', 'tsx'],
    ['scripts/build.ps1', 'powershell'],
    ['Cargo.toml', 'toml'],
  ])('路径 %s → %s', (path, id) => {
    expect(languageForPath(path)?.id).toBe(id)
  })

  it('没有扩展名或不认识的扩展名', () => {
    expect(languageForPath('Makefile')).toBeUndefined()
    expect(languageForPath('.gitignore')).toBeUndefined()
    expect(languageForPath('a.unknown')).toBeUndefined()
  })
})

describe('highlight', () => {
  it('按行给出令牌，颜色是 --tk-* 变量；结果缓存', async () => {
    const code = 'const n: number = 1 // one\nfunction f() { return "s" }'
    const lines = (await highlight(code, ts))!
    expect(lines).toHaveLength(2)
    const color = (line: number, content: string) =>
      lines[line]!.find((t) => t.content.trim() === content)?.color
    expect(color(0, 'const')).toBe('var(--tk-k)')
    expect(color(0, 'number')).toBe('var(--tk-t)')
    expect(color(0, '1')).toBe('var(--tk-n)')
    expect(color(1, 'f')).toBe('var(--tk-f)')
    const comment = lines[0]!.find((t) => t.content.includes('one'))!
    expect(comment).toMatchObject({ color: 'var(--tk-c)', italic: true })
    expect(lines.map((l) => l.map((t) => t.content).join('')).join('\n')).toBe(code)
    expect(cachedHighlight(code, ts)).toBe(lines)
    expect(await highlight(code, ts)).toBe(lines)
  })

  it('粗体（Markdown 标题等）', async () => {
    const lines = (await highlight('**bold**', languageByName('md')!))!
    expect(lines[0]!.some((t) => t.bold)).toBe(true)
  })

  it('过长不高亮；语言加载失败时返回 undefined', async () => {
    expect(await highlight('x'.repeat(HIGHLIGHT_MAX_CHARS + 1), ts)).toBeUndefined()
    const broken: LanguageInfo = {
      id: 'broken',
      label: '?',
      tone: '--tk-v',
      load: () => Promise.reject(new Error('nope')),
    }
    expect(await highlight('x', broken)).toBeUndefined()
  })

  it('缓存有上限', async () => {
    const json = languageByName('json')!
    for (let i = 0; i < 70; i++) await highlight(`{"k": ${i}}`, json)
    expect(cachedHighlight('{"k": 0}', json)).toBeUndefined()
    expect(cachedHighlight('{"k": 69}', json)).toBeDefined()
  })
})
