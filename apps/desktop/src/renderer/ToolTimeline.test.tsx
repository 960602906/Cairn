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
})

describe('terminalData', () => {
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
})
