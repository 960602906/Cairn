// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import type { ToolCallView } from '@cairn/core'
import type { TFunction } from '@cairn/i18n'
import type { ToolCall } from '@cairn/protocol'
import { FileText, SquareTerminal, Wrench } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  latestActivityHeadline,
  summarizeActivity,
  ToolKindIcon,
  ToolStatusIcon,
  toolIconFor,
} from './ToolTimeline.js'

afterEach(() => {
  cleanup()
})

const t = ((key: string) => key) as unknown as TFunction

const calls = [
  { id: 'c1', name: 'read_file', input: { path: 'src/a.ts' } },
  { id: 'c2', name: 'run_command', input: { command: 'npm test' } },
] as unknown as ToolCall[]

const tools = {
  c1: { toolCallId: 'c1', status: 'failed', durationMs: 100 },
  c2: { toolCallId: 'c2', status: 'completed', durationMs: 200, display: { exitCode: 0 } },
} as unknown as Record<string, ToolCallView>

describe('操作图标', () => {
  it('按工具名选图标，不认识的用扳手', () => {
    expect(toolIconFor('read_file')).toBe(FileText)
    expect(toolIconFor('run_command')).toBe(SquareTerminal)
    expect(toolIconFor('mcp__github__list_issues')).toBe(Wrench)
  })

  it('颜色跟随状态：完成弱化、执行中强调色、失败与非零退出红色', () => {
    const icon = (element: HTMLElement) => element.querySelector('svg')!
    const done = icon(render(<ToolKindIcon name="read_file" status="completed" />).container)
    expect(done.getAttribute('data-tool-icon')).toBe('read_file')
    expect(done.classList.contains('lucide-file-text')).toBe(true)
    expect(done.classList.contains('text-muted')).toBe(true)
    cleanup()
    const running = icon(render(<ToolKindIcon name="run_command" status="running" />).container)
    expect(running.classList.contains('text-accent')).toBe(true)
    cleanup()
    const exited = icon(
      render(<ToolKindIcon name="run_command" status="completed" exitCode={1} />).container,
    )
    expect(exited.classList.contains('text-danger')).toBe(true)
  })
})

describe('状态图标', () => {
  it('covers cancelled and waiting (requested) status shapes', () => {
    const icon = (element: HTMLElement) => element.querySelector('svg')!
    const cancelled = icon(render(<ToolStatusIcon status="cancelled" />).container)
    expect(cancelled.classList.contains('lucide-minus')).toBe(true)
    cleanup()
    const waiting = icon(render(<ToolStatusIcon status="requested" />).container)
    expect(waiting.classList.contains('lucide-circle')).toBe(true)
  })
})

describe('组头只说最新一步', () => {
  it('前面有失败的步骤也不改口；图标用最新一步', () => {
    const headline = latestActivityHeadline({ calls, tools, isRunning: false, t })
    expect(headline).toMatchObject({
      tone: 'done',
      label: 'tool.action.run_command',
      object: 'npm test',
      tool: { name: 'run_command', status: 'completed', exitCode: 0 },
    })
    expect(headline.meta).toBeDefined()
  })

  it('运行中流光；没有工具调用时说“思考过程”', () => {
    expect(latestActivityHeadline({ calls, tools, isRunning: true, t }).tone).toBe('running')
    const empty = latestActivityHeadline({ calls: [], tools: {}, isRunning: false, t })
    expect(empty.label).toBe('tool.group.thinking')
    expect(empty.tool).toBeUndefined()
  })

  it('summarizeActivity mirrors the latest step wording', () => {
    expect(summarizeActivity(calls, tools, t)).toBe('tool.action.run_command npm test')
    expect(summarizeActivity([], {}, t)).toBeUndefined()
  })
})
