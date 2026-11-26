// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { findTextRanges, matchElement } from './find-text.js'

afterEach(() => {
  document.body.innerHTML = ''
})

const setup = (html: string): HTMLDivElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

describe('findTextRanges', () => {
  it('finds every occurrence in document order, ignoring case', () => {
    const root = setup('<p>Hello Cairn</p><p>cairn again</p><span>no match</span>')
    const ranges = findTextRanges(root, 'CAIRN')
    expect(ranges.map((range) => range.toString())).toEqual(['Cairn', 'cairn'])
  })

  it('matches text split across inline markdown nodes', () => {
    const root = setup('<p>修复 <strong>登录</strong> 问题</p>')
    expect(findTextRanges(root, '复 登录').map((range) => range.toString())).toEqual(['复 登录'])
    expect(findTextRanges(root, '登录 问题').map((range) => range.toString())).toEqual([
      '登录 问题',
    ])
  })

  it('skips hidden helpers and returns nothing for a blank query', () => {
    const root = setup(
      '<span data-find-ignore>secret</span><p>shown <span data-find-ignore>secret</span> secret</p>',
    )
    expect(findTextRanges(root, 'secret').map((range) => range.toString())).toEqual(['secret'])
    expect(findTextRanges(root, '')).toEqual([])
    expect(findTextRanges(root, '   ')).toEqual([])
  })

  it('returns no match when the text is absent', () => {
    const root = setup('<p>只有这些文字</p>')
    expect(findTextRanges(root, '没有')).toEqual([])
  })
})

describe('matchElement', () => {
  it('resolves the element that contains the match', () => {
    const root = setup('<p>before <strong>needle</strong> after</p>')
    const [range] = findTextRanges(root, 'needle')
    expect(matchElement(range!)).toBe(root.querySelector('strong'))
  })
})
