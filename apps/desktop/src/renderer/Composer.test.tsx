// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import type { EventEnvelope, ProviderConfig, SessionStatus } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import {
  Composer,
  enabledModelChoices,
  modelLabels,
  ModelPicker,
  resolveDefaultModel,
  sameModel,
} from './Composer.js'
import { COMPOSER_FOCUS_EVENT } from './layout/shortcuts.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'
import { TooltipProvider } from './ui/index.js'

afterEach(cleanup)

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

const providers: ProviderConfig[] = [
  {
    id: 'p1',
    kind: 'openai',
    displayName: '供应商一',
    baseUrl: 'https://example.com',
    models: [
      { id: 'fast', ...capabilities },
      { id: 'off', displayName: '停用模型', enabled: false, ...capabilities },
    ],
  },
  {
    id: 'p2',
    kind: 'openai',
    displayName: '供应商二',
    baseUrl: 'https://example.com',
    models: [{ id: 'strong', displayName: '强', ...capabilities }],
  },
]

const fast = { providerId: 'p1', modelId: 'fast' }
const strong = { providerId: 'p2', modelId: 'strong' }

describe('Composer model helpers', () => {
  it('lists enabled models, resolves defaults, and compares model refs', () => {
    expect(enabledModelChoices(providers).map((choice) => choice.name)).toEqual(['fast', '强'])
    expect(sameModel(fast, { ...fast })).toBe(true)
    expect(sameModel(fast, strong)).toBe(false)
    expect(sameModel(undefined, fast)).toBe(false)
    expect(resolveDefaultModel(providers, strong)).toEqual(strong)
    expect(resolveDefaultModel(providers, { providerId: 'p1', modelId: 'missing' })).toEqual(fast)
    expect(resolveDefaultModel([], fast)).toBeUndefined()
  })

  it('labels configured, unknown, and missing models', () => {
    expect(modelLabels(fast, providers)).toEqual({ short: 'fast', full: '供应商一 · fast' })
    expect(modelLabels({ providerId: 'missing', modelId: 'raw' }, providers)).toEqual({
      short: 'raw',
      full: 'raw',
    })
    expect(modelLabels({ providerId: 'p1', modelId: 'unknown' }, providers)).toEqual({
      short: 'unknown',
      full: '供应商一 · unknown',
    })
    expect(modelLabels(undefined, providers)).toEqual({ short: undefined, full: undefined })
  })

  it('marks a fixed model', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed
          disabled={false}
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
          align="start"
        />
      </I18nextProvider>,
    )
    const trigger = screen.getByRole('button', { name: '模型：供应商一 · fast' })
    expect(trigger.getAttribute('title')).toBe('由 Agent 固定')
  })

  it('only emits a change for a different selection', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={onSelect}
        />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('menuitem', { name: /^fast/ }))
    expect(onSelect).not.toHaveBeenCalled()

    cleanup()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={onSelect}
        />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('menuitem', { name: /强/ }))
    expect(onSelect).toHaveBeenCalledWith(strong)
  })

  it('picks the thinking level of the current model', async () => {
    const user = userEvent.setup()
    const onSelectThinkingLevel = vi.fn()
    const reasoning: ProviderConfig[] = [
      {
        id: 'p2',
        kind: 'openai',
        displayName: '供应商二',
        baseUrl: 'https://example.com',
        models: [{ id: 'strong', displayName: '强', ...capabilities, supportsReasoning: true }],
      },
    ]
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={reasoning}
          model={strong}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
          thinkingLevel="low"
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nextProvider>,
    )
    expect(screen.getByText('思考强度')).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: '高' }))
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('high')
  })

  it('explains when the model does not support reasoning, and hides the section without a session', () => {
    const { rerender } = render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
          onSelectThinkingLevel={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.getByText('思考强度')).toBeTruthy()
    expect(screen.getByText('当前模型不支持推理')).toBeTruthy()

    rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.queryByText('思考强度')).toBeNull()
  })

  it('shows the empty label when no model is configured', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={[]}
          model={undefined}
          fixed={false}
          disabled
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    const trigger = screen.getByRole('button', { name: '模型：未配置模型' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('title')).toBeNull()
  })
})

describe('Composer /goal', () => {
  const runLimits = {
    maxStepsPerTurn: 50,
    maxTurnDurationMs: 1_800_000,
    maxConsecutiveToolErrors: 5,
  }
  const goalLimits = { maxTurns: 20, maxDurationMs: 3_600_000 }
  const mainModel = { providerId: 'p1', modelId: 'fast' }
  const ev = (seq: number, type: string, payload: object, turnId = 't1'): EventEnvelope =>
    ({ v: 1, sessionId: 's1', runId: 'r1', turnId, ts: seq, seq, type, payload }) as EventEnvelope

  const goalView = (extra: EventEnvelope[] = []) =>
    reduceSessionEvents(createSessionView('s1'), [
      ev(1, 'session.created', {
        projectId: 'p1',
        projectPath: '/w',
        workspacePath: '/w',
        title: 'x',
      }),
      ev(2, 'run.created', {
        agent: { id: 'a', version: 1 },
        model: mainModel,
        mode: 'interactive',
        limits: runLimits,
      }),
      ev(3, 'goal.created', { goalId: 'g1', condition: '测试全部通过', limits: goalLimits }),
      ev(4, 'message.user', {
        messageId: 'u1',
        content: [{ type: 'text', text: '测试全部通过' }],
      }),
      ...extra,
    ])

  const activeGoal = () => goalView([ev(5, 'turn.started', {})])
  const pausedGoal = () =>
    goalView([ev(5, 'turn.started', {}), ev(6, 'goal.paused', { goalId: 'g1', reason: 'user' })])

  function renderComposer(
    view = createSessionView('s1'),
    goalActions: {
      setGoal?: (sessionId: string, condition: string) => Promise<unknown>
      pauseGoal?: (sessionId: string) => Promise<unknown>
      resumeGoal?: (sessionId: string) => Promise<unknown>
      clearGoal?: (sessionId: string) => Promise<unknown>
    } = {},
    onOpenPanel?: ((panel: string) => void) | undefined,
    status: SessionStatus = 'idle',
  ) {
    const setGoal = goalActions.setGoal ?? vi.fn(async () => ({ ok: true }))
    const pauseGoal = goalActions.pauseGoal ?? vi.fn(async () => ({ ok: true }))
    const resumeGoal = goalActions.resumeGoal ?? vi.fn(async () => ({ ok: true }))
    const clearGoal = goalActions.clearGoal ?? vi.fn(async () => ({ ok: true }))
    const store = createStore<Record<string, unknown>>(() => ({
      sendPrompt: vi.fn(async () => true),
      setSessionModel: vi.fn(async () => true),
      setSessionThinkingLevel: vi.fn(async () => true),
      compactSession: vi.fn(async () => undefined),
      abort: vi.fn(async () => {}),
      updateSettings: vi.fn(async () => ({ permissionMode: 'ask' })),
      renameSession: vi.fn(async () => true),
      setSessionAgent: vi.fn(async () => true),
      inspectRun: vi.fn(async () => undefined),
      listSkills: vi.fn(async () => []),
      delegationTargets: vi.fn(async () => undefined),
      setGoal,
      pauseGoal,
      resumeGoal,
      clearGoal,
      inspections: {},
      settings: { providers, permissionMode: 'ask' },
      agents: [],
      projects: [],
      views: { s1: view },
      awaitingTurn: {},
    })) as unknown as SessionStore
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <TooltipProvider>
          <SessionStoreProvider store={store}>
            <Composer
              sessionId="s1"
              status={status}
              run={undefined}
              agent={undefined}
              model={mainModel}
              projectPath="/w"
              contextTokens={undefined}
              onOpenPanel={onOpenPanel}
              onNewChat={vi.fn()}
              onOpenSettings={vi.fn()}
              onOpenSearch={vi.fn()}
            />
          </SessionStoreProvider>
        </TooltipProvider>
      </I18nextProvider>,
    )
    return { setGoal, pauseGoal, resumeGoal, clearGoal, onOpenPanel }
  }

  const input = () => screen.getByLabelText('输入消息') as HTMLTextAreaElement

  it('focuses the input when the app dispatches the focus event', () => {
    renderComposer()
    const textarea = input()
    textarea.blur()
    expect(document.activeElement).not.toBe(textarea)
    window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT))
    expect(document.activeElement).toBe(textarea)
  })

  it('returns focus to the input after sending with the button', async () => {
    const user = userEvent.setup()
    renderComposer()
    const textarea = input()
    await user.type(textarea, '发出去')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(document.activeElement).toBe(textarea))
  })

  it('returns focus to the input after stopping', async () => {
    const user = userEvent.setup()
    renderComposer(createSessionView('s1'), {}, undefined, 'running')
    const textarea = input()
    await user.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(document.activeElement).toBe(textarea))
  })

  it('starts a goal and clears the draft on success', async () => {
    const user = userEvent.setup()
    const { setGoal } = renderComposer()
    await user.type(input(), '/goal 测试全部通过{Enter}')
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith('s1', '测试全部通过'))
    await screen.findByText(/已开始目标/)
    expect(input().value).toBe('')
  })

  it('keeps the draft and explains when the session already has a goal', async () => {
    const user = userEvent.setup()
    renderComposer(activeGoal(), {
      setGoal: vi.fn(async () => ({ ok: false, code: 'goal.exists' })),
    })
    await user.type(input(), '/goal 再来一个{Enter}')
    await screen.findByText(/已有目标/)
    expect(input().value).toBe('/goal 再来一个')
  })

  it('rejects an empty condition without calling the API', async () => {
    const user = userEvent.setup()
    const { setGoal } = renderComposer()
    await user.type(input(), '/goal set{Enter}')
    await screen.findByText(/请写下可验证的完成条件/)
    expect(setGoal).not.toHaveBeenCalled()
    expect(input().value).toBe('/goal set')
  })

  it('opens the goal panel for /goal status and notices when there is no goal', async () => {
    const user = userEvent.setup()
    const { onOpenPanel } = renderComposer(activeGoal(), {}, vi.fn())
    await user.type(input(), '/goal status{Enter}')
    await waitFor(() => expect(onOpenPanel).toHaveBeenCalledWith('goal'))

    cleanup()
    renderComposer()
    await user.type(input(), '/goal status{Enter}')
    await screen.findByText(/当前会话没有未结束的目标/)
  })

  it('pauses and clears without clearing the draft', async () => {
    const user = userEvent.setup()
    const { pauseGoal, clearGoal } = renderComposer(activeGoal())
    await user.type(input(), '/goal pause{Enter}')
    await waitFor(() => expect(pauseGoal).toHaveBeenCalledWith('s1'))
    expect(input().value).toBe('/goal pause')

    await user.clear(input())
    await user.type(input(), '/goal clear{Enter}')
    await waitFor(() => expect(clearGoal).toHaveBeenCalledWith('s1'))
    expect(input().value).toBe('/goal clear')
  })

  it('does not resume an active goal', async () => {
    const user = userEvent.setup()
    const { resumeGoal } = renderComposer(activeGoal())
    await user.type(input(), '/goal resume{Enter}')
    await screen.findByText(/目标正在运行/)
    expect(resumeGoal).not.toHaveBeenCalled()
    expect(input().value).toBe('/goal resume')
  })

  it('resumes a paused goal', async () => {
    const user = userEvent.setup()
    const { resumeGoal } = renderComposer(pausedGoal())
    await user.type(input(), '/goal resume{Enter}')
    await waitFor(() => expect(resumeGoal).toHaveBeenCalledWith('s1'))
    await screen.findByText(/目标已恢复/)
    expect(input().value).toBe('')
  })

  it('explains a goal pause failure', async () => {
    const user = userEvent.setup()
    renderComposer(pausedGoal(), {
      pauseGoal: vi.fn(async () => ({ ok: false, code: 'goal.not_found' })),
    })
    await user.type(input(), '/goal pause{Enter}')
    await screen.findByText(/当前会话没有未结束的目标/)
    expect(input().value).toBe('/goal pause')
  })

  it('explains a goal clear failure', async () => {
    const user = userEvent.setup()
    renderComposer(activeGoal(), {
      clearGoal: vi.fn(async () => ({ ok: false, code: 'goal.not_found' })),
    })
    await user.type(input(), '/goal clear{Enter}')
    await screen.findByText(/当前会话没有未结束的目标/)
    expect(input().value).toBe('/goal clear')
  })

  it('explains a goal resume failure', async () => {
    const user = userEvent.setup()
    renderComposer(pausedGoal(), {
      resumeGoal: vi.fn(async () => ({ ok: false, code: 'goal.not_found' })),
    })
    await user.type(input(), '/goal resume{Enter}')
    await screen.findByText(/当前会话没有未结束的目标/)
    expect(input().value).toBe('/goal resume')
  })

  it('notices when /goal status has a goal but no panel target', async () => {
    const user = userEvent.setup()
    const { onOpenPanel } = renderComposer(activeGoal(), {}, undefined)
    await user.type(input(), '/goal status{Enter}')
    await screen.findByText(/当前会话没有未结束的目标/)
    expect(onOpenPanel).toBeUndefined()
    expect(input().value).toBe('/goal status')
  })

  it('merges plan mode into the permission menu and shows it on the trigger', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await user.click(await screen.findByRole('menuitem', { name: /计划模式/ }))
    expect(screen.getByRole('button', { name: '权限模式：询问，计划模式已开启' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /计划模式已开启/ }))
    await user.click(await screen.findByRole('menuitem', { name: /计划模式/ }))
    expect(screen.getByRole('button', { name: '权限模式：询问' })).toBeTruthy()
  })

  it('returns focus to the input after picking a mode or pressing Escape', async () => {
    const user = userEvent.setup()
    renderComposer()
    const textarea = input()
    await user.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await user.click(await screen.findByRole('menuitem', { name: /计划模式/ }))
    await waitFor(() => expect(document.activeElement).toBe(textarea))

    await user.click(screen.getByRole('button', { name: /计划模式已开启/ }))
    await screen.findByRole('menuitem', { name: /计划模式/ })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(textarea))
  })

  it('does not pull focus back to the input when the menu is dismissed elsewhere', async () => {
    const user = userEvent.setup()
    renderComposer()
    const textarea = input()
    await user.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await screen.findByRole('menuitem', { name: /计划模式/ })
    // 模态菜单会给 body 加上 pointer-events: none，用事件模拟点在菜单外面。
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /计划模式/ })).toBeNull())
    await waitFor(() => expect(document.activeElement).not.toBe(textarea))
  })

  it('returns focus to the input after switching models', async () => {
    const user = userEvent.setup()
    renderComposer()
    const textarea = input()
    await user.click(screen.getByRole('button', { name: '模型：供应商一 · fast' }))
    await user.click(await screen.findByRole('menuitem', { name: /强/ }))
    await waitFor(() => expect(document.activeElement).toBe(textarea))
  })

  it('returns focus to the input after closing the agent picker', async () => {
    const user = userEvent.setup()
    renderComposer()
    const textarea = input()
    await user.type(textarea, '/agent{Enter}')
    await screen.findByRole('listbox', { name: '选择 Agent' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(textarea))
  })

  it('toggles plan mode with the shortcut while the command list is open', async () => {
    const user = userEvent.setup()
    renderComposer()
    const textarea = input()
    await user.type(textarea, '/')
    await screen.findByRole('listbox', { name: '输入指令' })
    fireEvent.keyDown(textarea, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: /计划模式已开启/ })).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: '权限模式：询问' })).toBeTruthy()
  })
})
