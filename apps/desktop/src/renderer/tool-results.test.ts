import { describe, expect, it } from 'vitest'
import { parseReadFileOutput, parseRunCommandOutput } from './tool-results.js'

describe('parseReadFileOutput', () => {
  it('标题、带行号的正文（空行只有行号）与末尾的说明', () => {
    const text = [
      'File: src/a.ts | lines 9-11 of 40 | UTF-8 | LF',
      ' 9\tconst a = 1',
      '10',
      '11\t\tindented\twith tab',
      '[Showing lines 9-11 of 40. Call read_file with offset=12 to continue.]',
    ].join('\n')
    expect(parseReadFileOutput(text)).toEqual({
      path: 'src/a.ts',
      startLine: 9,
      code: 'const a = 1\n\n\tindented\twith tab',
      notes: ['[Showing lines 9-11 of 40. Call read_file with offset=12 to continue.]'],
    })
  })

  it('没有编码信息的标题也能识别', () => {
    expect(parseReadFileOutput('File: a | lines 1-1 of 1\n1\tx')).toMatchObject({ code: 'x' })
  })

  it.each([
    ['不是 read_file 的格式', 'hello'],
    ['二进制文件', 'File: a.png | binary file, 10 bytes, not shown.'],
    ['空文件', 'File: a.txt | empty | UTF-8'],
    ['行号不连续', 'File: a | lines 1-2 of 2\n1\tx\n3\ty'],
    ['行数对不上', 'File: a | lines 1-3 of 3\n1\tx\n2\ty'],
    ['正文中间被截断', 'File: a | lines 1-2 of 2\n1\tx\n[... 9 characters truncated ...]\n2\ty'],
    ['其他文字', 'File: a | lines 1-1 of 1\n1\tx\noops'],
  ])('%s：返回 undefined', (_name, text) => {
    expect(parseReadFileOutput(text)).toBeUndefined()
  })
})

describe('parseRunCommandOutput', () => {
  it('退出码、耗时、stdout 与 stderr', () => {
    expect(
      parseRunCommandOutput('Exit code: 2\nDuration: 1.2 s\n\nstdout:\na\nb\n\nstderr:\nwarn'),
    ).toEqual({
      kind: 'terminal',
      exitCode: 2,
      timedOut: false,
      aborted: false,
      durationMs: 1200,
      chunks: [
        { stream: 'stdout', text: 'a\nb\n' },
        { stream: 'stderr', text: 'warn\n' },
      ],
      omittedChars: 0,
    })
  })

  it('没有输出；超时（带等待输入的提示）；取消；信号', () => {
    expect(parseRunCommandOutput('Exit code: 0\nDuration: 0 s\n\n(no output)')).toMatchObject({
      exitCode: 0,
      chunks: [],
    })
    expect(
      parseRunCommandOutput(
        'Timed out after 3 s; the command and its child processes were terminated.\nThere was no output…\nDuration: 3 s',
      ),
    ).toMatchObject({ exitCode: null, timedOut: true, durationMs: 3000 })
    expect(
      parseRunCommandOutput(
        'Cancelled; the command and its child processes were terminated.\nDuration: 0.1 s',
      ),
    ).toMatchObject({ aborted: true })
    expect(parseRunCommandOutput('Terminated by signal SIGKILL.\nDuration: 1 s')).toMatchObject({
      signal: 'SIGKILL',
      exitCode: null,
    })
    expect(
      parseRunCommandOutput('Terminated by signal unknown.\nDuration: 1 s'),
    ).not.toHaveProperty('signal')
  })

  it('格式对不上时返回 undefined', () => {
    expect(parseRunCommandOutput('hello')).toBeUndefined()
    expect(parseRunCommandOutput('Exit code: 0\nno duration')).toBeUndefined()
  })
})
