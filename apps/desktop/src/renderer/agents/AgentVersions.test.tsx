// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { AgentVersions } from './AgentVersions.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const version = (n: number) => ({
  version: n,
  publishedAt: n * 1000,
  name: { 'zh-CN': `v${n}` },
  description: {},
  instructionsBytes: 10,
  usedBySessions: n,
})

function renderVersions(
  handlers: Record<string, (params: unknown) => unknown>,
  onRestore = vi.fn(),
) {
  const fakeApi = {
    request: async (method: string, params: unknown) => handlers[method]?.(params),
    on: () => () => {},
  }
  const store = createSessionStore(fakeApi as unknown as MainApi)
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <AgentVersions agentId="agent.test" onRestore={onRestore} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return onRestore
}

describe('AgentVersions component', () => {
  it('renders version list, shows diff, and triggers restore', async () => {
    const onRestore = vi.fn()
    const fakeApi = {
      request: async (method: string, params: unknown) => {
        if (method === 'agent.versions') {
          return {
            versions: [
              { version: 2, publishedAt: 2000, description: { 'zh-CN': 'v2' } },
              { version: 1, publishedAt: 1000, description: { 'zh-CN': 'v1' } },
            ],
          }
        }
        if (method === 'agent.diff') {
          return {
            fields: [{ path: 'instructions', from: 'Prompt v1', to: 'Prompt v2' }],
            instructions: {
              from: 'Prompt v1',
              to: 'Prompt v2',
            },
          }
        }
        if (method === 'agent.get') {
          const p = params as { agentId: string; version: number }
          return {
            agentId: p.agentId,
            source: 'user',
            archived: false,
            published: { version: p.version, instructions: 'Restored prompt' },
          }
        }
        if (method === 'agent.saveDraft') {
          return {
            agentId: 'agent.test',
            source: 'user',
            archived: false,
            draft: { id: 'agent.test' },
          }
        }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)

    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentVersions agentId="agent.test" onRestore={onRestore} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )

    // Wait for versions to load
    await waitFor(() => {
      expect(screen.getAllByText(/v2/i).length).toBeGreaterThan(0)
    })

    // Find restore button
    const restoreBtn = screen.getAllByRole('button', { name: /恢复/i })[0]!
    expect(restoreBtn).toBeDefined()
    fireEvent.click(restoreBtn)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalled()
    })
  })
})

describe('AgentVersions branches', () => {
  it('shows the empty state when there are no versions', async () => {
    renderVersions({
      'agent.versions': () => ({ versions: [] }),
      'agent.diff': () => ({ fields: [], instructions: { from: '', to: '' } }),
    })
    expect(await screen.findByText('还没有发布过版本。')).toBeDefined()
  })

  it('shows no-diff when the endpoints are identical', async () => {
    renderVersions({
      'agent.versions': () => ({ versions: [version(1)] }),
      'agent.diff': () => ({ fields: [], instructions: { from: 'same', to: 'same' } }),
    })
    expect(await screen.findByText('没有差异')).toBeDefined()
  })

  it('renders structured fields, instruction diff and switches endpoints', async () => {
    const seen: string[] = []
    renderVersions({
      'agent.versions': () => ({ versions: [version(1), version(2)] }),
      'agent.diff': () => {
        seen.push('diff')
        return {
          fields: [
            { path: 'model', from: 'inherit', to: { mode: 'fixed' } },
            { path: 'icon', from: undefined, to: 'bot' },
          ],
          instructions: { from: 'one\ntwo', to: 'one\nthree' },
        }
      },
    })
    expect(await screen.findByText('结构化字段')).toBeDefined()
    expect(screen.getByText('inherit')).toBeDefined()
    expect(screen.getByText('—')).toBeDefined()
    expect(screen.getByText('{"mode":"fixed"}')).toBeDefined()
    expect(screen.getAllByText('v2').length).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText('对比基线'), { target: { value: 'draft' } })
    fireEvent.change(screen.getByLabelText('对比目标'), { target: { value: '1' } })
    await waitFor(() => expect(seen.length).toBeGreaterThan(1))
  })

  it('ignores restore when the version is missing or the draft save fails', async () => {
    const onRestore = renderVersions({
      'agent.versions': () => ({ versions: [version(1)] }),
      'agent.diff': () => ({ fields: [], instructions: { from: 'a', to: 'b' } }),
      'agent.get': () => undefined,
    })
    fireEvent.click(await screen.findByRole('button', { name: '恢复为草稿' }))
    await waitFor(() => expect(onRestore).not.toHaveBeenCalled())

    cleanup()
    const onRestore2 = renderVersions({
      'agent.versions': () => ({ versions: [version(1)] }),
      'agent.diff': () => ({ fields: [], instructions: { from: 'a', to: 'b' } }),
      'agent.get': () => ({
        agentId: 'agent.test',
        source: 'user',
        archived: false,
        published: undefined,
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: '恢复为草稿' }))
    await waitFor(() => expect(onRestore2).not.toHaveBeenCalled())
  })

  it('restores with optional fields and forwards the saved draft', async () => {
    let saved: Record<string, unknown> | undefined
    const onRestore = renderVersions({
      'agent.versions': () => ({ versions: [version(1)] }),
      'agent.diff': () => ({ fields: [], instructions: { from: 'a', to: 'b' } }),
      'agent.get': () => ({
        agentId: 'agent.test',
        source: 'user',
        archived: false,
        published: {
          id: 'agent.test',
          version: 1,
          name: { 'zh-CN': 'v1' },
          description: {},
          icon: 'bot',
          color: 'agent-blue',
          instructions: 'Do it',
          model: { mode: 'inherit' },
          tools: { allow: [] },
          skills: { allow: [] },
          permissions: 'ask',
          limits: {},
          context: { includeProjectInstructions: true, compaction: 'auto' },
          memory: { scopes: ['session'], write: 'never' },
          tags: ['x'],
          inputSchema: {},
          outputSchema: {},
        },
      }),
      'agent.saveDraft': (params) => {
        saved = params as Record<string, unknown>
        return { agentId: 'agent.test', source: 'user', archived: false }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: '恢复为草稿' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalled())
    expect(saved?.definition).toMatchObject({ icon: 'bot', color: 'agent-blue', tags: ['x'] })
  })
})
