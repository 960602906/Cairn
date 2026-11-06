import { describe, expect, it } from 'vitest'
import { languageByName, languageForPath } from './languages.js'

describe('languages', () => {
  it('按语言名查找（不区分大小写，忽略首尾空白）', () => {
    expect(languageByName(' TS ')?.id).toBe('typescript')
    expect(languageByName('bash')?.id).toBe('shellscript')
    expect(languageByName('c++')?.label).toBe('C++')
    expect(languageByName('brainfuck')).toBeUndefined()
    expect(languageByName(undefined)).toBeUndefined()
    expect(languageByName('')).toBeUndefined()
  })

  it('按扩展名查找；没有扩展名或以点开头的文件没有语言', () => {
    expect(languageForPath('src/App.tsx')?.id).toBe('tsx')
    expect(languageForPath('C:\\work\\main.RS')?.id).toBe('rust')
    expect(languageForPath('Makefile')).toBeUndefined()
    expect(languageForPath('.gitignore')).toBeUndefined()
  })

  it('每种语言的语法都能加载', async () => {
    const names = [
      'typescript',
      'tsx',
      'javascript',
      'jsx',
      'json',
      'jsonc',
      'python',
      'shellscript',
      'powershell',
      'css',
      'html',
      'markdown',
      'yaml',
      'toml',
      'rust',
      'go',
      'java',
      'c',
      'cpp',
      'csharp',
      'sql',
      'diff',
    ]
    for (const name of names) {
      const info = languageByName(name)!
      expect(info.id).toBe(name)
      const { default: grammars } = await info.load()
      expect(grammars.length).toBeGreaterThan(0)
    }
  }, 30_000)
})
