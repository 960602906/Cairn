/** 组件预览页用的 store：改动记录与内容来自下面的示例，不连接主进程。 */
import type { FileChangeSummary, FileContent } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'

export const PREVIEW_SESSION = 'preview'
export const PREVIEW_TURN = 'turn-1'

export const SUM_BEFORE = `/**
 * 对数组求和。
 */
export function sum(values) {
  let total = 0
  for (const v of values) total += v
  return total
}

export function average(values) {
  return sum(values) / values.length
}

export function max(values) {
  return Math.max(...values)
}

export function min(values) {
  return Math.min(...values)
}
`

export const SUM_AFTER = `/**
 * 对数组求和，跳过不是数字的值。
 */
export function sum(values) {
  let total = 0
  for (const v of values) {
    if (typeof v === 'number') total += v
  }
  return total
}

export function average(values) {
  return sum(values) / values.length
}

export function max(values) {
  return Math.max(...values)
}

export function min(values) {
  if (values.length === 0) return undefined
  return Math.min(...values)
}
`

const TEST_AFTER = `import { sum } from '../src/sum.mjs'

test('跳过非数字', () => {
  expect(sum([1, '2', 3])).toBe(4)
})
`

const contents: Record<string, { before?: FileContent; after?: FileContent }> = {
  c1: { before: { kind: 'text', text: SUM_BEFORE }, after: { kind: 'text', text: SUM_AFTER } },
  c2: { after: { kind: 'text', text: TEST_AFTER } },
  c3: { before: { kind: 'text', text: '# 旧说明\n' } },
}

const change = (
  changeId: string,
  path: string,
  kind: FileChangeSummary['kind'],
  added: number,
  removed: number,
): FileChangeSummary => ({
  changeId,
  path,
  kind,
  status: 'pending',
  turnId: PREVIEW_TURN,
  hunks: [],
  added,
  removed,
  createdAt: 1,
})

export const PREVIEW_CHANGES = [
  change('c1', 'src/sum.mjs', 'modify', 4, 2),
  change('c2', 'test/sum.test.mjs', 'create', 5, 0),
  change('c3', 'docs/old.md', 'delete', 0, 1),
]

export function createPreviewStore() {
  const api = {
    ready: () => Promise.resolve(),
    request: async (method: string, params: { changeId?: string }) =>
      method === 'changes.content' ? contents[params.changeId ?? ''] : {},
    on: () => () => {},
  } as unknown as MainApi
  const store = createSessionStore(api)
  store.setState({ changes: { [PREVIEW_SESSION]: PREVIEW_CHANGES } })
  return store
}
