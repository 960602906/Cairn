import { describe, expect, it } from 'vitest'
import {
  ANSI_STRIPPER_MAX_PENDING,
  AnsiParser,
  AnsiStripper,
  nearestPaletteColor,
  parseAnsi,
  stripAnsi,
} from './ansi.js'

const ESC = '\x1b'

describe('stripAnsi', () => {
  it.each([
    ['颜色', `${ESC}[31mred${ESC}[0m plain`, 'red plain'],
    ['复合参数', `${ESC}[1;38;5;196mx${ESC}[m`, 'x'],
    ['光标与清除', `a${ESC}[2K${ESC}[1Gb${ESC}[?25l`, 'ab'],
    ['OSC 标题（BEL）', `${ESC}]0;title\x07text`, 'text'],
    ['OSC 链接（ST）', `${ESC}]8;;https://x.dev${ESC}\\link${ESC}]8;;${ESC}\\`, 'link'],
    ['两字符序列', `${ESC}(Bok${ESC}=`, 'ok'],
    ['末尾不完整的 CSI', `done${ESC}[3`, 'done'],
    ['末尾不完整的 OSC', `done${ESC}]0;ti`, 'done'],
    ['单独的 ESC', `a${ESC}`, 'a'],
    ['其他控制符', 'a\x07b\x08c\x00d', 'abcd'],
    ['保留制表符', 'a\tb', 'a\tb'],
    ['CRLF', 'a\r\nb\r\n', 'a\nb\n'],
    ['回车重写', '10%\r50%\r100%\nnext', '100%\nnext'],
    ['行尾回车', 'abc\r', 'abc'],
    ['开头回车', '\rabc', 'abc'],
    ['空字符串', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(stripAnsi(input)).toBe(expected)
  })
})

describe('AnsiStripper', () => {
  it('序列与回车跨块', () => {
    const s = new AnsiStripper()
    let out = s.push(`a${ESC}[3`)
    out += s.push(`1mb\r`)
    out += s.push(`c${ESC}[0m\nd`)
    out += s.end()
    expect(out).toBe('c\nd')
  })

  it('只交出结束的行', () => {
    const s = new AnsiStripper()
    expect(s.push('one\ntw')).toBe('one\n')
    expect(s.push('o\n')).toBe('two\n')
    expect(s.end()).toBe('')
  })

  it('没有换行的长行先交出，保留末尾可能不完整的序列', () => {
    const s = new AnsiStripper()
    const long = 'x'.repeat(ANSI_STRIPPER_MAX_PENDING)
    expect(s.push(long)).toBe('')
    expect(s.push(`y${ESC}[3`)).toBe(`${long}y`)
    expect(s.push('2mz')).toBe('')
    expect(s.end()).toBe('z')
  })

  it('长行没有 ESC 时整段交出', () => {
    const s = new AnsiStripper()
    const long = 'x'.repeat(ANSI_STRIPPER_MAX_PENDING + 1)
    expect(s.push(long)).toBe(long)
    expect(s.end()).toBe('')
  })
})

describe('nearestPaletteColor', () => {
  it.each([
    [1, 1],
    [15, 15],
    [196, 9], // 纯红
    [46, 10], // 纯绿
    [16, 0], // 黑
    [231, 15], // 白
    [232, 0], // 深灰
    [244, 8], // 中灰
    [255, 7], // 浅灰
  ])('%i → %i', (input, expected) => {
    expect(nearestPaletteColor(input)).toBe(expected)
  })
})

describe('parseAnsi', () => {
  it('前景、背景与属性', () => {
    const [line] = parseAnsi(`${ESC}[1;31mA${ESC}[22;42mB${ESC}[39;49mC${ESC}[0m`)
    expect(line).toEqual([
      { text: 'A', style: { bold: true, fg: 1 } },
      { text: 'B', style: { fg: 1, bg: 2 } },
      { text: 'C', style: {} },
    ])
  })

  it('亮色、256 色与真彩色', () => {
    const [line] = parseAnsi(
      `${ESC}[92ma${ESC}[103mb${ESC}[38;5;196mc${ESC}[48;2;1;2;255md${ESC}[38:2::16:32:48me${ESC}[38:5:46mf`,
    )
    expect(line!.map((s) => s.style)).toEqual([
      { fg: 10 },
      { fg: 10, bg: 11 },
      { fg: 9, bg: 11 },
      { fg: 9, bg: '#0102ff' },
      { fg: '#102030', bg: '#0102ff' },
      { fg: 10, bg: '#0102ff' },
    ])
  })

  it('冒号分隔的真彩色（不带色彩空间）与越界数值', () => {
    const [line] = parseAnsi(`${ESC}[38:2:300:0:0ma${ESC}[38;5;999mb${ESC}[38;2;1mc${ESC}[38;9md`)
    expect(line!.map((s) => s.style)).toEqual([{ fg: '#ff0000' }])
    expect(line![0]!.text).toBe('abcd')
  })

  it('其他属性的开与关', () => {
    const [line] = parseAnsi(
      `${ESC}[2;3;4;7;9ma${ESC}[23;24;27;29mb${ESC}[21mc${ESC}[22md${ESC}[5;8;foom`,
    )
    expect(line!.map((s) => s.style)).toEqual([
      { dim: true, italic: true, underline: true, inverse: true, strike: true },
      { dim: true },
      { dim: true, underline: true },
      { underline: true },
    ])
  })

  it('空参数等于重置；其他 CSI 忽略', () => {
    const [line] = parseAnsi(`${ESC}[31ma${ESC}[mb${ESC}[2Kc`)
    expect(line).toEqual([
      { text: 'a', style: { fg: 1 } },
      { text: 'bc', style: {} },
    ])
  })

  it('按行切分，样式跨行保留，末尾换行不产生空行', () => {
    const lines = parseAnsi(`${ESC}[32mone\ntwo${ESC}[0m\n\nthree\n`)
    expect(lines).toEqual([
      [{ text: 'one', style: { fg: 2 } }],
      [{ text: 'two', style: { fg: 2 } }],
      [],
      [{ text: 'three', style: {} }],
    ])
  })

  it('回车重写只保留最后一段', () => {
    expect(parseAnsi(`${ESC}[33m10%\r${ESC}[32m100%\n`)).toEqual([
      [{ text: '100%', style: { fg: 2 } }],
    ])
  })

  it('stdout 与 stderr 片段分开，样式在两者之间延续', () => {
    const lines = parseAnsi([
      { stream: 'stdout', text: `${ESC}[31mout ` },
      { stream: 'stderr', text: 'err\n' },
      { stream: 'stdout', text: 'next' },
    ])
    expect(lines).toEqual([
      [
        { text: 'out ', style: { fg: 1 } },
        { text: 'err', style: { fg: 1 }, stderr: true },
      ],
      [{ text: 'next', style: { fg: 1 } }],
    ])
  })

  it('序列跨块拼接', () => {
    const parser = new AnsiParser()
    parser.write(`a${ESC}[3`)
    parser.write('1mb')
    parser.write(`${ESC}]0;ti`)
    parser.write(`tle\x07c${ESC}`)
    parser.write('[0md')
    expect(parser.lines()).toEqual([
      [
        { text: 'a', style: {} },
        { text: 'bc', style: { fg: 1 } },
        { text: 'd', style: {} },
      ],
    ])
  })

  it('1 万行彩色输出在 200ms 内解析完', () => {
    const text = Array.from(
      { length: 10_000 },
      (_, i) => `${ESC}[32m✓${ESC}[0m test ${i} ${ESC}[2m(${i % 97}ms)${ESC}[22m`,
    ).join('\n')
    const start = performance.now()
    const lines = parseAnsi(text)
    const elapsed = performance.now() - start
    expect(lines).toHaveLength(10_000)
    expect(stripAnsi(text).split('\n')[9999]).toBe('✓ test 9999 (8ms)')
    expect(elapsed).toBeLessThan(200)
  })
})
