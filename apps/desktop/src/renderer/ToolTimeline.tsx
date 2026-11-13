/**
 * 工具步骤（M2-05，视觉规范 §6；M1-16b 起的工具卡片改写）：助手消息中的工具调用按顺序排成列表。
 *
 * - 每一步一行：左侧是环石 C（执行中旋转、完成绿色、失败红色；等待中空心圆、取消 –），
 *   无纵向连接线；文字是“动作 + 对象”（如“读取 `src/a.ts`”），进行中的步骤文字流光；右侧是耗时或状态。
 * - 点击一行展开详情：参数与完整输出（可滚动）、截断说明。失败的错误不用展开就显示。
 * - `run_command` 用终端卡片（M2-06）：执行中直接显示实时输出，完成后展开显示；退出码不是 0 时默认展开。
 *   `read_file` 展开后用代码卡片显示读到的内容。其他工具执行中显示实时输出的最后几行。
 * - 状态文字总在（完成时只给读屏），供读屏与测试使用。
 *
 * 不使用 `<p>`：消息流的测试按段落读取消息正文。
 */
import { ChevronRight, Minus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PROPOSE_PLAN_TOOL,
  REVISE_PLAN_STEPS_TOOL,
  UPDATE_PLAN_STEP_TOOL,
  type LiveToolOutputView,
  type ToolCallView,
} from '@cairn/core'
import { translateError } from '@cairn/i18n'
import type { ContentPart } from '@cairn/protocol'
import { CodeCard } from './CodeCard.js'
import { formatDuration } from './format.js'
import { languageForPath } from './languages.js'
import { SandboxBadge } from './SandboxBadge.js'
import { TerminalCard, type TerminalCardProps } from './TerminalCard.js'
import { parseReadFileOutput, parseRunCommandOutput } from './tool-results.js'
import { CairnMark, cn, Shimmer } from './ui/index.js'

export { formatDuration }

/** 输出最多显示的行数。 */
export const OUTPUT_PREVIEW_LINES = 5
/** 展开的代码卡片的最大高度。 */
const CODE_MAX_HEIGHT = 420
/** 参数摘要的最大字符数。 */
export const INPUT_SUMMARY_CHARS = 120

/** 参数中最能说明调用的字段，按顺序取第一个字符串。 */
const SUMMARY_KEYS = ['command', 'pattern', 'query', 'path', 'url', 'name'] as const

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** 参数摘要：常见字段（命令、路径、搜索词）直接显示，否则显示单行 JSON。 */
export function summarizeInput(input: unknown): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const key of SUMMARY_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') {
        return truncate(value.replace(/\s+/g, ' ').trim(), INPUT_SUMMARY_CHARS)
      }
    }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    json = undefined
  }
  return truncate(json ?? String(input), INPUT_SUMMARY_CHARS)
}

/** 取文本的前（或后）几行，返回显示的行与省略的行数。 */
export function previewLines(
  text: string,
  from: 'start' | 'end',
  max = OUTPUT_PREVIEW_LINES,
): { readonly lines: string; readonly omitted: number } {
  const all = text.replace(/\n+$/, '').split('\n')
  if (all.length <= max) return { lines: all.join('\n'), omitted: 0 }
  const shown = from === 'start' ? all.slice(0, max) : all.slice(-max)
  return { lines: shown.join('\n'), omitted: all.length - max }
}

const outputText = (parts: readonly ContentPart[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')

/** 有动作文字的内置工具；其他工具显示工具名。 */
const ACTIONS: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'search',
  'run_command',
  'load_skill',
  'start_command',
])

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

/** 终端卡片的数据：执行中来自实时输出，完成后来自 `display`（旧事件从交给模型的文本解析）。 */
export function terminalData(
  args: unknown,
  tool: ToolCallView | undefined,
  live: LiveToolOutputView | undefined,
): TerminalCardProps | undefined {
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const command = typeof record['command'] === 'string' ? record['command'] : summarizeInput(args)
  if (tool?.status === 'running') {
    return {
      command,
      chunks: live?.chunks ?? [],
      omittedChars: live?.omittedChars ?? 0,
      omittedAt: 0,
      running: true,
      sandbox: tool.sandbox,
    }
  }
  if (tool?.status !== 'completed') return undefined
  const display = tool.display ?? parseRunCommandOutput(outputText(tool.output ?? []))
  if (!display) return undefined
  return {
    command,
    chunks: display.chunks,
    omittedChars: display.omittedChars,
    omittedAt: display.omittedAt ?? 0,
    exitCode: display.exitCode,
    signal: display.signal,
    timedOut: display.timedOut,
    aborted: display.aborted,
    durationMs: display.durationMs,
    shell: display.shell,
    cwd: display.cwd,
    sandbox: display.sandbox ?? tool.sandbox,
  }
}

function Node({ status }: { readonly status: ToolCallView['status'] }) {
  const base = 'flex size-4 shrink-0 items-center justify-center'
  switch (status) {
    case 'completed':
      return (
        <span aria-hidden className={cn(base, 'text-ok')}>
          <CairnMark size={13} />
        </span>
      )
    case 'running':
      return (
        <span
          aria-hidden
          className={cn(base, 'animate-spin text-accent')}
          style={{ animationDuration: '1.4s' }}
        >
          <CairnMark size={13} />
        </span>
      )
    case 'failed':
      return (
        <span aria-hidden className={cn(base, 'text-danger')}>
          <CairnMark size={13} />
        </span>
      )
    case 'cancelled':
      return (
        <span aria-hidden className={cn(base, 'text-faint')}>
          <Minus className="size-3" />
        </span>
      )
    default:
      return (
        <span aria-hidden className={base}>
          <span className="size-2 rounded-full shadow-[inset_0_0_0_1.5px_var(--faint)]" />
        </span>
      )
  }
}

export interface ToolStepProps {
  readonly name: string
  /** 模型给出的参数（工具事件到达之前使用）。 */
  readonly input: unknown
  readonly tool: ToolCallView | undefined
  readonly live: LiveToolOutputView | undefined
  /** 这一步正在等待审批（右侧显示“等待审批”）。 */
  readonly awaitingApproval?: boolean
}

/** 时间线中的一步。 */
export function ToolStep({ name, input, tool, live, awaitingApproval = false }: ToolStepProps) {
  const { t, i18n } = useTranslation('session')
  const [openState, setOpen] = useState<boolean>()
  const status = tool?.status ?? 'requested'
  const args = tool?.input ?? input
  const running = status === 'running'
  const output = tool?.output ? outputText(tool.output) : ''
  const terminal = name === 'run_command' ? terminalData(args, tool, live) : undefined
  const file =
    name === 'read_file' && status === 'completed' ? parseReadFileOutput(output) : undefined
  const open = openState ?? (terminal !== undefined && !terminal.running && terminal.exitCode !== 0)
  const liveText = running && live && !terminal ? live.chunks.map((c) => c.text).join('') : ''
  const tail = liveText.trim() === '' ? undefined : previewLines(liveText, 'end')
  const argsRecord =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const planTool =
    name === PROPOSE_PLAN_TOOL || name === REVISE_PLAN_STEPS_TOOL || name === UPDATE_PLAN_STEP_TOOL
  // 计划类工具的参数是一整份计划对象，直接抖 JSON 很丑；用一句人能读懂的话代替。
  let action: string
  let object: string
  if (name === PROPOSE_PLAN_TOOL) {
    const goal = argsRecord['goal']
    action = t('tool.action.propose_plan')
    object = typeof goal === 'string' && goal !== '' ? goal : summarizeInput(args)
  } else if (name === REVISE_PLAN_STEPS_TOOL) {
    const steps = argsRecord['steps']
    action = t('tool.action.revise_plan_steps')
    object = t('tool.planSteps', { steps: Array.isArray(steps) ? steps.length : 0 })
  } else if (name === UPDATE_PLAN_STEP_TOOL) {
    action = t('tool.action.update_plan_step')
    const stepId = typeof argsRecord['stepId'] === 'string' ? argsRecord['stepId'] : ''
    const stepStatus = argsRecord['status']
    const statusLabel =
      stepStatus === 'in_progress' || stepStatus === 'done' || stepStatus === 'skipped'
        ? t(`plan.step.${stepStatus}`)
        : ''
    object = [stepId, statusLabel].filter((part) => part !== '').join(' · ')
  } else {
    action = name === 'load_skill' ? '' : ACTIONS.has(name) ? t(`tool.action.${name}`) : name
    object = summarizeInput(args)
  }
  const statusText =
    awaitingApproval && status === 'requested'
      ? t('tool.awaitingApproval')
      : t(`tool.status.${status}`)
  const label = (
    <>
      {action !== '' && <span className="shrink-0">{action}</span>}
      <code
        className={cn(
          'min-w-0 truncate text-[12.5px] text-fg2',
          name === 'load_skill' || planTool ? 'font-sans' : 'rounded-[4px] bg-sunk px-1 font-mono',
        )}
      >
        {object}
      </code>
    </>
  )

  return (
    <li className="relative">
      <section aria-label={t('message.toolCall', { name })} data-status={status}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group/step flex w-full items-center gap-2.5 rounded-item py-1 text-left text-ui text-fg2 outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Node status={status} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {running ? (
              <Shimmer className="flex min-w-0 items-center gap-1.5">{label}</Shimmer>
            ) : (
              label
            )}
          </span>
          {terminal?.sandbox && <SandboxBadge execution={terminal.sandbox} compact />}
          <span
            className={cn(
              'tabular shrink-0 text-note',
              status === 'failed' ? 'text-danger' : 'text-muted',
            )}
          >
            {status === 'completed' ? (
              <>
                <span className="sr-only">{statusText} </span>
                {tool?.durationMs !== undefined && formatDuration(tool.durationMs)}
              </>
            ) : (
              statusText
            )}
          </span>
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-faint opacity-0 transition-[transform,opacity] group-hover/step:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </button>
        {tool?.error && (
          <div role="note" className="ml-[26px] text-note text-danger">
            {translateError(i18n, tool.error)}
          </div>
        )}
        {tail && (
          <div className="mt-1 ml-[26px] rounded-item bg-sunk px-3 py-2 font-mono text-[12px] text-fg2">
            {tail.omitted > 0 && (
              <div className="text-faint">{t('tool.earlierLines', { count: tail.omitted })}</div>
            )}
            <pre className="whitespace-pre-wrap break-all">{tail.lines}</pre>
          </div>
        )}
        {terminal && (terminal.running || open) && (
          <div className="mt-1 mb-2 ml-[26px] flex flex-col gap-1 text-note">
            <TerminalCard {...terminal} />
            {tool?.truncated && <div className="text-muted">{t('tool.truncated')}</div>}
          </div>
        )}
        {open && file && (
          <div className="mt-1 mb-2 ml-[26px] flex flex-col gap-1 text-note">
            <CodeCard
              className="my-0"
              code={file.code}
              path={file.path}
              language={languageForPath(file.path)}
              startLine={file.startLine}
              maxHeight={CODE_MAX_HEIGHT}
            />
            {file.notes.map((note, i) => (
              <div key={i} className="font-mono text-[11.5px] text-muted">
                {note}
              </div>
            ))}
          </div>
        )}
        {open && !terminal && !file && (
          <div className="mt-1 mb-2 ml-[26px] flex flex-col gap-2 text-note">
            <div>
              <div className="mb-1 text-muted">{t('tool.input')}</div>
              <pre className="max-h-48 overflow-auto rounded-item bg-sunk px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-all text-fg2">
                {formatInput(args)}
              </pre>
            </div>
            {output.trim() !== '' && (
              <div>
                <div className="mb-1 text-muted">{t('tool.output')}</div>
                <pre className="max-h-72 overflow-auto rounded-item bg-sunk px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-all text-fg2">
                  {output.replace(/\n+$/, '')}
                </pre>
              </div>
            )}
            {tool?.truncated && <div className="text-muted">{t('tool.truncated')}</div>}
          </div>
        )}
      </section>
    </li>
  )
}

/** 一条助手消息中的工具调用时间线。 */
export function ToolTimeline({ children }: { readonly children: ReactNode }) {
  return <ol className="my-2 flex flex-col">{children}</ol>
}
