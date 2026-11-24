import { describe, expect, it } from 'vitest'
import { splitStableBlocks } from './markdown-blocks.js'

const SAMPLE = [
  '# 标题',
  '',
  '第一段，提到 `src/a.ts`。',
  '',
  '- 一',
  '- 二',
  '',
  '  续行',
  '',
  '1. 步骤',
  '',
  '   说明',
  '',
  '2. 下一步',
  '',
  '```ts',
  'const a = 1',
  '',
  'const b = 2',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '> 引用',
  '',
  '最后一段',
  '',
].join('\n')

describe('splitStableBlocks', () => {
  it('在顶格的块之间切开；最后两行还不能判断', () => {
    expect(splitStableBlocks('a\n\nb\n\nc')).toEqual(['a', 'b\n\nc'])
    expect(splitStableBlocks('')).toEqual([''])
    expect(splitStableBlocks('hello')).toEqual(['hello'])
  })

  it('代码围栏里的空行不切，未闭合的围栏留在最后一块', () => {
    expect(splitStableBlocks('```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter\n\nend')).toEqual([
      '```ts\nconst a = 1\n\nconst b = 2\n```',
      'after\n\nend',
    ])
    expect(splitStableBlocks('intro\n\n```ts\nx\n\ny\n\nz')).toEqual([
      'intro',
      '```ts\nx\n\ny\n\nz',
    ])
    // 波浪线围栏里的反引号不算关闭
    expect(splitStableBlocks('~~~\n```\n\n~~~\n\nok\n\nend')).toEqual([
      '~~~\n```\n\n~~~',
      'ok\n\nend',
    ])
  })

  it('列表项、缩进续行与缩进代码留在同一块', () => {
    expect(splitStableBlocks('1. a\n\n   more\n\n2. b\n\nPara\n\nend')).toEqual([
      '1. a\n\n   more\n\n2. b',
      'Para\n\nend',
    ])
    expect(splitStableBlocks('para\n\n    code\n\n    code2\n\nnext\n\nend')).toEqual([
      'para\n\n    code\n\n    code2',
      'next\n\nend',
    ])
  })

  it('不切出空块', () => {
    expect(splitStableBlocks('\n\nfoo\n\nbar\n\nbaz')).toEqual(['\n\nfoo', 'bar\n\nbaz'])
    expect(splitStableBlocks('a\n\n\n\nb\n\nc')).toEqual(['a\n\n', 'b\n\nc'])
  })

  it('逐字追加时前面的块保持不变；用空行接起来就是原文', () => {
    const full = splitStableBlocks(SAMPLE)
    expect(full).toHaveLength(6)
    for (let n = 0; n <= SAMPLE.length; n++) {
      const prefix = SAMPLE.slice(0, n)
      const blocks = splitStableBlocks(prefix)
      expect(blocks.join('\n\n')).toBe(prefix)
      expect(blocks.slice(0, -1)).toEqual(full.slice(0, blocks.length - 1))
    }
  })
})
