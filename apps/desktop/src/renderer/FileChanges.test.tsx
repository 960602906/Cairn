// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import { RpcError, type FileChangeSummary, type FileContent } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { combineContent, SessionChanges, TurnChanges } from './FileChanges.js'
import { createSessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')
afterEach(cleanup)

const change = (over: Partial<FileChangeSummary>): FileChangeSummary => ({
  changeId: 'c1',
  path: 'src/a.ts',
  kind: 'modify',
  status: 'pending',
  turnId: 't1',
  hunks: [],
  added: 1,
  removed: 1,
  createdAt: 1,
  ...over,
})
const text = (t: string): FileContent => ({ kind: 'text', text: t })

const CHANGES = [
  change({ changeId: 'a1', path: 'src/a.ts' }),
  change({ changeId: 'n1', path: 'src/new.ts', kind: 'create', added: 2, removed: 0 }),
  change({ changeId: 'a2', path: 'src/a.ts', added: 1, removed: 0 }),
  change({ changeId: 'o1', path: 'old.md', kind: 'modify', turnId: 't0' }),
]
const CONTENT: Record<string, { before?: FileContent; after?: FileContent }> = {
  a1: { before: text('one\ntwo\n'), after: text('one\nTWO\n') },
  a2: { before: text('one\nTWO\n'), after: text('one\nTWO\nthree\n') },
  n1: { after: text('x\ny\n') },
  o1: { before: text('a'), after: text('b') },
}

function setup({ busy = false, fail = {} as Record<string, unknown> } = {}) {
  let changes = CHANGES
  const request = vi.fn(
    async (method: string, params: { changeId?: string; changeIds?: string[] }) => {
      if (fail[method]) throw fail[method]
      if (method === 'changes.content') return CONTENT[params.changeId!]
      if (method === 'changes.list') return { changes }
      if (method === 'changes.revert') {
        changes = changes.map((c) =>
          params.changeIds!.includes(c.changeId) ? { ...c, status: 'reverted' as const } : c,
        )
        return { changes: [] }
      }
      return {}
    },
  )
  const api = { ready: () => Promise.resolve(), request, on: () => () => {} } as unknown as MainApi
  const store = createSessionStore(api)
  store.setState({
    changes: { s1: changes },
    views: { s1: createSessionView('s1') },
    awaitingTurn: busy ? { s1: true } : {},
  })
  const wrap = (ui: ReactNode) =>
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
      </I18nextProvider>,
    )
  return { request, store, wrap }
}

const rowButton = (name: RegExp) => screen.getByRole('button', { name })

describe('TurnChanges', () => {
  it('列出这一轮改动的文件与合计；没有改动时不显示', () => {
    const { wrap } = setup()
    const { rerender } = wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    const card = screen.getByRole('region', { name: '本轮变更' })
    expect(within(card).getByText('2 个文件')).toBeTruthy()
    expect(card.querySelector('header')!.textContent).toContain('+4 −1')
    const rows = within(card).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual(['TSsrc/a.ts+2 −1', 'TSsrc/new.ts新文件+2 −0'])
    rerender(
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={setup().store}>
          <TurnChanges sessionId="s1" turnId="nope" />
        </SessionStoreProvider>
      </I18nextProvider>,
    )
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('点击文件展开 diff：取最早一次改动之前与最后一次改动之后的内容', async () => {
    const { wrap, request } = setup()
    wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    await userEvent.click(rowButton(/^src\/a\.ts/))
    expect(rowButton(/^src\/a\.ts/).getAttribute('aria-expanded')).toBe('true')
    const diff = await screen.findByRole('figure', { name: '差异：src/a.ts' })
    await waitFor(() => expect(diff.querySelectorAll('[data-type="add"]')).toHaveLength(2))
    expect(request).toHaveBeenCalledWith('changes.content', { sessionId: 's1', changeId: 'a1' })
    expect(request).toHaveBeenCalledWith('changes.content', { sessionId: 's1', changeId: 'a2' })
    await userEvent.click(rowButton(/^src\/a\.ts/))
    expect(screen.queryByRole('figure')).toBeNull()
  })

  it('只有一次改动时只读取一次内容；读取失败时说明', async () => {
    const { wrap, request } = setup({
      fail: { 'changes.content': new RpcError('changes.blob_missing') },
    })
    wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    await userEvent.click(rowButton(/^src\/new\.ts/))
    expect(await screen.findByText('无法读取改动内容')).toBeTruthy()
    expect(request.mock.calls.filter(([m]) => m === 'changes.content')).toHaveLength(1)
  })

  it('撤销此文件：确认后撤销这个文件的全部改动，列表随之更新', async () => {
    const { wrap, request } = setup()
    wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    await userEvent.click(rowButton(/^src\/a\.ts/))
    await userEvent.click(await screen.findByRole('button', { name: '撤销此文件' }))
    const dialog = await screen.findByRole('dialog', { name: '撤销对这个文件的改动？' })
    expect(
      within(dialog).getByText('文件会恢复为改动之前的内容。其他文件和对话记录不受影响。'),
    ).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(request).not.toHaveBeenCalledWith('changes.revert', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: '撤销此文件' }))
    const again = await screen.findByRole('dialog')
    await userEvent.click(within(again).getByRole('button', { name: '撤销此文件' }))
    expect(request).toHaveBeenCalledWith('changes.revert', {
      sessionId: 's1',
      changeIds: ['a1', 'a2'],
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /^src\/a\.ts/ })).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('新建的文件撤销后会被删除（确认框写明）', async () => {
    const { wrap } = setup()
    wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    await userEvent.click(rowButton(/^src\/new\.ts/))
    await userEvent.click(await screen.findByRole('button', { name: '撤销此文件' }))
    expect(
      await screen.findByText('这个文件是新建的，撤销后会被删除。其他文件和对话记录不受影响。'),
    ).toBeTruthy()
  })

  it('会话正在运行时不能撤销', async () => {
    const { wrap } = setup({ busy: true })
    wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    await userEvent.click(rowButton(/^src\/a\.ts/))
    const button = (await screen.findByRole('button', { name: '撤销此文件' })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('还没有会话投影时不能撤销', async () => {
    const { wrap, store } = setup()
    store.setState({ views: {} })
    wrap(<TurnChanges sessionId="s1" turnId="t1" />)
    await userEvent.click(rowButton(/^src\/a\.ts/))
    const button = (await screen.findByRole('button', { name: '撤销此文件' })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})

describe('SessionChanges', () => {
  it('顶栏摘要：本会话所有改动的文件数与增删数，点击打开列表', async () => {
    const { wrap } = setup()
    wrap(<SessionChanges sessionId="s1" />)
    const button = screen.getByRole('button', {
      name: '本会话改动了 3 个文件，新增 5 行，删除 2 行',
    })
    expect(button.textContent).toBe('3 个文件+5 −2')
    await userEvent.click(button)
    const dialog = await screen.findByRole('dialog', { name: '本会话的改动' })
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['TSsrc/a.ts+2 −1', 'TSsrc/new.ts新文件+2 −0', 'MDold.md+1 −1'])
  })

  it('没有改动或还没读取时不显示', () => {
    const { wrap, store } = setup()
    store.setState({ changes: {} })
    wrap(<SessionChanges sessionId="s1" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('combineContent', () => {
  it('二进制、过大与文本', () => {
    expect(combineContent({ kind: 'binary', size: 1 }, text('a'))).toEqual({ state: 'binary' })
    expect(combineContent(undefined, { kind: 'too_large', size: 1 })).toEqual({
      state: 'too_large',
    })
    expect(combineContent(undefined, text('a'))).toEqual({ state: 'ready', before: '', after: 'a' })
  })
})
