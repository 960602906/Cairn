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

describe('ToolStep：run_command', () => {
  it('执行中直接显示终端卡片，不再显示实时输出预览', () => {
    step({ tool: tool({ status: 'running' }), live: live('line 1\nline 2\n') })
    expect(terminal()).toBeTruthy()
    expect(screen.getByRole('log').textContent).toContain('line 2')
    expect(document.querySelector('pre')).toBeNull()
  })

  it('执行中的终端卡片显示这条命令的沙箱', () => {
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
    const badge = within(terminal()!).getByTestId('sandbox-badge')
    expect(badge.textContent).toBe('沙箱：工作区可写 · 网络未隔离')
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

  it('非 0 退出默认展开，可以收起；截断时显示说明', async () => {
    const user = userEvent.setup()
    step({ tool: tool({ display: display({ exitCode: 1 }), truncated: true }) })
    expect(terminal()).toBeTruthy()
    expect(screen.getByText('（输出过长，交给模型时已截断）')).toBeTruthy()
    await user.click(toggle())
    expect(terminal()).toBeNull()
  })

  it('旧事件没有 display 时从交给模型的文本解析', () => {
    step({ tool: tool({ output: text('Exit code: 3\nDuration: 0.5 s\n\nstderr:\nboom') }) })
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

describe('ToolStep：完成态', () => {
  it('完成后的节点是绿色品牌 Logo，不再显示对勾', () => {
    const { container } = step({ tool: tool({ status: 'completed' }) })
    const node = container
      .querySelector('section[data-status="completed"]')!
      .querySelector('span[aria-hidden]')!
    expect(node.className).toContain('text-ok')
    expect(node.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('svg.lucide-check')).toBeNull()
  })

  it('失败节点使用红色品牌 Logo，不再显示红色 X', () => {
    const { container } = step({ tool: tool({ status: 'failed' }) })
    const node = container
      .querySelector('section[data-status="failed"]')!
      .querySelector('span[aria-hidden]')!
    expect(node.className).toContain('text-danger')
    expect(node.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('svg.lucide-x')).toBeNull()
  })

  it('工具列表没有竖线', () => {
    const { container } = step({ tool: tool({ status: 'completed' }) })
    const ol = container.querySelector('ol')!
    expect(ol.className).not.toContain('before:bg-hair2')
  })

  it('技能加载只显示技能名，不显示动作词或原始 JSON', () => {
    render(
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
