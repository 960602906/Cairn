// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { LiveToolOutputView, ToolCallView } from '@cairn/core'
import type { ToolDisplay } from '@cairn/protocol'
import { ToolStep, ToolTimeline, terminalData, type ToolStepProps } from './ToolTimeline.js'

const i18n = createI18n('zh-CN')
afterEach(cleanup)

const tool = (over: Partial<ToolCallView> = {}): ToolCallView => ({
  toolCallId: 'tc1',
  runId: 'r1',
  turnId: undefined,
  name: 'run_command',
  input: { command: 'npm test' },
  status: 'completed',
  requestedAt: 0,
  output: undefined,
  display: undefined,
  sandbox: undefined,
  truncated: false,
  error: undefined,
  cancelReason: undefined,
  durationMs: 1500,
  ...over,
})
const text = (t: string) => [{ type: 'text' as const, text: t }]
const display = (over: Partial<ToolDisplay> = {}): ToolDisplay => ({
  kind: 'terminal',
  exitCode: 0,
  timedOut: false,
  aborted: false,
  durationMs: 1500,
  shell: 'bash',
  cwd: '/w',
  chunks: [{ stream: 'stdout', text: '\x1b[32mgreen\x1b[0m\n' }],
  omittedChars: 0,
  ...over,
})
const live = (t: string): LiveToolOutputView => ({
  toolCallId: 'tc1',
  runId: 'r1',
  chunks: [{ stream: 'stdout', text: t }],
  omittedChars: 0,
  lastDeltaSeq: 1,
})

const step = (props: Partial<ToolStepProps> & Pick<ToolStepProps, 'tool'>) =>
  render(
    <I18nextProvider i18n={i18n}>
      <ToolTimeline>
        <ToolStep name="run_command" input={undefined} live={undefined} {...props} />
      </ToolTimeline>
    </I18nextProvider>,
  )
const terminal = () => screen.queryByRole('figure', { name: '终端：npm test' })
const toggle = () => document.querySelector<HTMLButtonElement>('button[aria-expanded]')!

describe('ToolTimeline 汇总折叠', () => {
  const steps = (
    <>
      <ToolStep
        name="read_file"
        input={{ path: 'a.ts' }}
        tool={tool({ name: 'read_file', input: { path: 'a.ts' } })}
        live={undefined}
      />
      <ToolStep name="run_command" input={{ command: 'npm test' }} tool={tool()} live={undefined} />
    </>
  )
  const group = (props: { running?: boolean; attention?: boolean } = {}) =>
    render(
      <I18nextProvider i18n={i18n}>
        <ToolTimeline count={2} {...props}>
          {steps}
        </ToolTimeline>
      </I18nextProvider>,
    )

  it('正常结束时默认收起，展开后保留逐条工具详情', async () => {
    const user = userEvent.setup()
    group()
    const summary = screen.getByRole('button', { name: '已执行 2 个步骤' })
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /读取.*a.ts/ })).toBeNull()
    await user.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
  })

  it('运行中或需要留意时默认展开，用户仍可手动收起', async () => {
    const user = userEvent.setup()
    const running = group({ running: true })
    const summary = screen.getByRole('button', { name: '正在执行 2 个步骤' })
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    await user.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    running.rerender(
      <I18nextProvider i18n={i18n}>
        <ToolTimeline count={2} attention>
          {steps}
        </ToolTimeline>
      </I18nextProvider>,
    )
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: '2 个步骤 · 需要留意' })).toBeTruthy()
    cleanup()
    group({ attention: true })
    expect(
      screen.getByRole('button', { name: '2 个步骤 · 需要留意' }).getAttribute('aria-expanded'),
    ).toBe('true')
  })
})

describe('ToolStep：run_command', () => {
  it('执行中默认收起，点开显示实时输出；不再显示实时输出预览', async () => {
    const user = userEvent.setup()
    step({ tool: tool({ status: 'running' }), live: live('line 1\nline 2\n') })
    expect(terminal()).toBeNull()
    expect(document.querySelector('pre')).toBeNull()
    await user.click(toggle())
    expect(terminal()).toBeTruthy()
    expect(screen.getByRole('log').textContent).toContain('line 2')
  })

  it('执行中的终端卡片显示这条命令的沙箱', async () => {
    const user = userEvent.setup()
    step({
      tool: tool({
        status: 'running',
        sandbox: {
          profile: 'workspace-write',
          network: 'none',
          mechanism: 'restricted-token',
          enforced: true,
          networkIsolated: false,
        },
      }),
      live: live('line 1\n'),
    })
    await user.click(toggle())
    const badge = within(terminal()!).getByTestId('sandbox-badge')
    expect(badge.textContent).toBe('沙箱：工作区可写 · 网络未隔离')
  })

  it('展开后沙箱徽标只出现一次', async () => {
    const user = userEvent.setup()
    step({
      tool: tool({
        display: display({
          sandbox: {
            profile: 'workspace-write',
            network: 'none',
            mechanism: 'restricted-token',
            enforced: true,
            networkIsolated: false,
          },
        }),
      }),
    })
    await user.click(toggle())
    expect(screen.getAllByTestId('sandbox-badge')).toHaveLength(1)
  })

  it('成功后默认收起，点开显示带颜色的 display', async () => {
    const user = userEvent.setup()
    step({ tool: tool({ display: display(), output: text('Exit code: 0') }) })
    expect(terminal()).toBeNull()
    await user.click(toggle())
    const card = terminal()!
    expect(within(card).getByText('green').getAttribute('style')).toContain('var(--term-c2)')
    expect(within(card).getByTitle('/w').textContent).toBe('bash · 工作目录 /w')
  })

  it('非 0 退出默认收起，显示退出码标签，点开展开并显示截断说明', async () => {
    const user = userEvent.setup()
    step({ tool: tool({ display: display({ exitCode: 1 }), truncated: true }) })
    expect(terminal()).toBeNull()
    expect(screen.getByText('退出码 1')).toBeTruthy()
    await user.click(toggle())
    expect(terminal()).toBeTruthy()
    expect(screen.getByText('（输出过长，交给模型时已截断）')).toBeTruthy()
    await user.click(toggle())
    expect(terminal()).toBeNull()
  })

  it('旧事件没有 display 时从交给模型的文本解析', async () => {
    const user = userEvent.setup()
    step({ tool: tool({ output: text('Exit code: 3\nDuration: 0.5 s\n\nstderr:\nboom') }) })
    expect(terminal()).toBeNull()
    expect(screen.getByText('退出码 3')).toBeTruthy()
    await user.click(toggle())
    const card = terminal()!
    expect(within(card).getByText('退出码 3')).toBeTruthy()
    expect(within(card).getByText('boom').getAttribute('style')).toContain('var(--term-err)')
  })

  it('解析不了时退回显示参数与原文', async () => {
    const user = userEvent.setup()
    step({ tool: tool({ output: text('something else') }) })
    await user.click(toggle())
    expect(terminal()).toBeNull()
    expect(screen.getByText('something else')).toBeTruthy()
  })
})

describe('ToolStep：read_file', () => {
  const output = text(
    'File: src/a.ts | lines 3-4 of 9 | UTF-8 | LF\n3\tconst a = 1\n4\tconst b = 2\n[Showing lines 3-4 of 9.]',
  )

  it('展开后用代码卡片显示，行号从读取位置开始，附带说明', async () => {
    const user = userEvent.setup()
    step({
      name: 'read_file',
      tool: tool({ name: 'read_file', input: { path: 'src/a.ts' }, output }),
    })
    expect(screen.queryByRole('figure')).toBeNull()
    await user.click(toggle())
    const card = screen.getByRole('figure', { name: '代码：src/a.ts' })
    expect(
      [...card.querySelectorAll('[data-line]')].map((r) => r.getAttribute('data-line')),
    ).toEqual(['3', '4'])
    expect(screen.getByText('[Showing lines 3-4 of 9.]')).toBeTruthy()
  })

  it('格式不符时退回显示原文', async () => {
    const user = userEvent.setup()
    step({
      name: 'read_file',
      tool: tool({
        name: 'read_file',
        input: { path: 'a.png' },
        output: text('File: a.png | binary'),
      }),
    })
    await user.click(toggle())
    expect(screen.queryByRole('figure')).toBeNull()
    expect(screen.getByText('File: a.png | binary')).toBeTruthy()
  })
})

describe('ToolStep：其他工具', () => {
  it('执行中仍显示实时输出的最后几行', () => {
    step({ name: 'grep', tool: tool({ name: 'grep', status: 'running' }), live: live('hit\n') })
    expect(document.querySelector('pre')!.textContent).toBe('hit')
    expect(screen.queryByRole('figure')).toBeNull()
  })

  it('renders cancelled steps, awaiting approval and undefined or image-only arguments', async () => {
    const user = userEvent.setup()
    step({
      name: 'search',
      tool: tool({ name: 'search', status: 'requested' }),
      awaitingApproval: true,
    })
    expect(screen.getByText(/等待审批/)).toBeTruthy()
    cleanup()

    step({
      name: 'search',
      tool: tool({ name: 'search', status: 'cancelled', input: undefined }),
    })
    expect(screen.getByText(/已取消/)).toBeTruthy()
    await user.click(toggle())
    expect(screen.getAllByText('undefined').length).toBeGreaterThan(0)
    cleanup()

    step({
      name: 'search',
      tool: tool({
        name: 'search',
        status: 'completed',
        input: 'query',
        output: [{ type: 'image', data: '', mediaType: 'image/png' }],
      }),
    })
    await user.click(toggle())
    expect(screen.queryByText('输出')).toBeNull()
  })
})

describe('ToolStep：ask_user', () => {
  const ask = (output: unknown, input: unknown) =>
    tool({ name: 'ask_user', status: 'completed', input, output: text(JSON.stringify(output)) })

  it('shows the first question in the summary and the answers when expanded', async () => {
    const user = userEvent.setup()
    step({
      name: 'ask_user',
      input: { questions: [{ question: '用哪种方案？' }] },
      tool: ask(
        { answers: [{ question: '用哪种方案？', selected: ['A'] }] },
        {
          questions: [{ question: '用哪种方案？' }],
        },
      ),
    })
    expect(screen.getByText(/用哪种方案/)).toBeTruthy()
    await user.click(toggle())
    expect(screen.getByText('用哪种方案？ → A')).toBeTruthy()
  })

  it('says the user dismissed the questions instead of dumping JSON', async () => {
    const user = userEvent.setup()
    step({ name: 'ask_user', input: { questions: 'oops' }, tool: ask({ cancelled: true }, {}) })
    await user.click(toggle())
    expect(screen.getByText('你取消了回答')).toBeTruthy()
  })

  it('falls back to the raw output when it is neither an answer nor a cancellation', async () => {
    const user = userEvent.setup()
    step({ name: 'ask_user', input: {}, tool: ask({ answers: 'x' }, {}) })
    await user.click(toggle())
    expect(screen.getByText('{"answers":"x"}')).toBeTruthy()
  })
})

describe('ToolStep：完成态', () => {
  it('完成后的节点是绿色对勾', () => {
    const { container } = step({ tool: tool({ status: 'completed' }) })
    const node = container.querySelector('section[data-status="completed"] svg.lucide-check')!
    expect(node.getAttribute('class')).toContain('text-ok')
  })

  it('失败节点是红色叉', () => {
    const { container } = step({ tool: tool({ status: 'failed' }) })
    const node = container.querySelector('section[data-status="failed"] svg.lucide-x')!
    expect(node.getAttribute('class')).toContain('text-danger')
  })

  it('执行中的节点是转圈的缺口圆', () => {
    const { container } = step({ tool: tool({ status: 'running' }) })
    const node = container.querySelector('section[data-status="running"] svg.lucide-loader-circle')!
    expect(node.getAttribute('class')).toContain('animate-spin')
    expect(node.getAttribute('class')).toContain('text-accent')
  })

  it('等待中的节点是空心圆', () => {
    const { container } = step({ tool: tool({ status: 'requested' }) })
    expect(
      container.querySelector('section[data-status="requested"] svg.lucide-circle'),
    ).toBeTruthy()
  })

  it('工具列表没有竖线', () => {
    const { container } = step({ tool: tool({ status: 'completed' }) })
    const ol = container.querySelector('ol')!
    expect(ol.className).not.toContain('before:bg-hair2')
  })

  it('技能加载只显示技能名，不显示动作词或原始 JSON', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ToolTimeline>
          <ToolStep
            name="load_skill"
            input={{ name: 'using-superpowers' }}
            tool={tool({
              name: 'load_skill',
              status: 'completed',
              input: { name: 'using-superpowers' },
            })}
            live={undefined}
          />
        </ToolTimeline>
      </I18nextProvider>,
    )
    expect(screen.queryByText('加载')).toBeNull()
    expect(screen.getByText('using-superpowers')).toBeTruthy()
    expect(document.body.textContent).not.toContain('load_skill')
    expect(document.body.textContent).not.toContain('"name"')
    // 没有动作词也要占住动作列，否则对象、耗时和箭头会整体左移、错位。
    expect(container.querySelector('button[aria-expanded]')!.children).toHaveLength(5)
  })
})

describe('terminalData', () => {
  const sandbox = {
    profile: 'workspace-write' as const,
    network: 'none' as const,
    mechanism: 'restricted-token' as const,
    enforced: true,
    networkIsolated: false,
  }
  const other = { ...sandbox, profile: 'read-only' as const }

  it('还没开始执行时没有数据；命令不是字符串时用参数摘要', () => {
    expect(terminalData({ command: 'x' }, undefined, undefined)).toBeUndefined()
    expect(terminalData({}, tool({ status: 'requested' }), undefined)).toBeUndefined()
    expect(terminalData({ command: 1 }, tool({ status: 'running' }), undefined)).toMatchObject({
      chunks: [],
      omittedChars: 0,
      running: true,
    })
    expect(
      terminalData(null, tool({ display: display({ omittedAt: 4 }) }), undefined),
    ).toMatchObject({
      omittedAt: 4,
      shell: 'bash',
    })
  })

  it('运行中取工具事件的沙箱，完成后优先用显示的沙箱', () => {
    expect(
      terminalData({ command: 'x' }, tool({ status: 'running', sandbox }), undefined),
    ).toMatchObject({ sandbox })
    expect(
      terminalData(
        { command: 'x' },
        tool({ display: display({ sandbox: other }), sandbox }),
        undefined,
      ),
    ).toMatchObject({ sandbox: other })
    expect(
      terminalData({ command: 'x' }, tool({ display: display(), sandbox }), undefined),
    ).toMatchObject({ sandbox })
  })
})

describe('ToolStep：计划工具', () => {
  const label = () => toggle().textContent
  const code = () => document.querySelector('code')!

  it('propose_plan 显示动作与目标，而不是整段 JSON', () => {
    step({
      name: 'propose_plan',
      tool: tool({
        name: 'propose_plan',
        input: { goal: '梳理登录流程', steps: [{ id: 's1', title: '读代码' }] },
      }),
    })
    expect(label()).toContain('制定计划')
    expect(code().textContent).toBe('梳理登录流程')
  })

  it('revise_plan_steps 显示调整后的步骤数', () => {
    step({
      name: 'revise_plan_steps',
      tool: tool({
        name: 'revise_plan_steps',
        input: { steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
      }),
    })
    expect(label()).toContain('调整计划')
    expect(code().textContent).toBe('3 个步骤')
  })

  it('update_plan_step 显示步骤 id 与状态', () => {
    step({
      name: 'update_plan_step',
      tool: tool({
        name: 'update_plan_step',
        input: { stepId: 's2', status: 'in_progress' },
      }),
    })
    expect(label()).toContain('更新步骤')
    expect(code().textContent).toBe('s2 · 进行中')
  })

  it('create_task_list 显示标题', () => {
    step({
      name: 'create_task_list',
      tool: tool({
        name: 'create_task_list',
        input: { title: '修测试', items: [{ title: '读用例' }] },
      }),
    })
    expect(label()).toContain('创建任务列表')
    expect(code().textContent).toBe('修测试')
  })

  it('revise_task_items 显示条目数', () => {
    step({
      name: 'revise_task_items',
      tool: tool({
        name: 'revise_task_items',
        input: { listId: 'tl1', items: [{ id: 'a' }, { id: 'b' }] },
      }),
    })
    expect(label()).toContain('调整任务')
    expect(code().textContent).toBe('2 项')
  })

  it('update_task_item 显示条目 id 与状态', () => {
    step({
      name: 'update_task_item',
      tool: tool({
        name: 'update_task_item',
        input: { listId: 'tl1', itemId: 'a', status: 'done' },
      }),
    })
    expect(label()).toContain('更新任务')
    expect(code().textContent).toBe('a · 已完成')
  })

  it('任务工具缺少参数时退回摘要或留空', () => {
    step({
      name: 'create_task_list',
      tool: tool({ name: 'create_task_list', input: { title: '' } }),
    })
    expect(label()).toContain('创建任务列表')
    expect(code().textContent).toContain('"title":""')

    cleanup()
    step({
      name: 'revise_task_items',
      tool: tool({ name: 'revise_task_items', input: {} }),
    })
    expect(label()).toContain('调整任务')
    expect(code().textContent).toBe('0 项')

    cleanup()
    step({
      name: 'update_task_item',
      tool: tool({ name: 'update_task_item', input: { listId: 'tl1' } }),
    })
    expect(label()).toContain('更新任务')
    expect(code().textContent).toBe('')
  })

  it('propose_plan 没有目标时退回参数摘要', () => {
    step({
      name: 'propose_plan',
      tool: tool({ name: 'propose_plan', input: {} }),
    })
    expect(code().textContent).toBe('{}')
  })

  it('revise_plan_steps 没有步骤列表时显示 0 个步骤', () => {
    step({
      name: 'revise_plan_steps',
      tool: tool({ name: 'revise_plan_steps', input: {} }),
    })
    expect(code().textContent).toBe('0 个步骤')
  })

  it('update_plan_step 显示完成状态', () => {
    step({
      name: 'update_plan_step',
      tool: tool({ name: 'update_plan_step', input: { stepId: 's1', status: 'done' } }),
    })
    expect(code().textContent).toBe('s1 · 已完成')
  })

  it('update_plan_step 缺少 id 或状态未知时不显示多余文字', () => {
    step({
      name: 'update_plan_step',
      tool: tool({ name: 'update_plan_step', input: { status: 'blocked' } }),
    })
    expect(label()).toContain('更新步骤')
    expect(code().textContent).toBe('')
  })

  it('执行中的工具显示最后几行实时输出，并提示前面省略了行', () => {
    step({
      name: 'read_file',
      tool: tool({ name: 'read_file', status: 'running', input: { path: 'a.ts' } }),
      live: live('1\n2\n3\n4\n5\n6\n7\n'),
    })
    expect(screen.getByText(/前面还有 2 行/)).toBeTruthy()
    expect(document.querySelector('pre')?.textContent).toBe('3\n4\n5\n6\n7')
  })
})
