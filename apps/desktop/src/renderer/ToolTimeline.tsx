/**
 * 工具步骤（M2-05，视觉规范 §6；M1-16b 起的工具卡片改写）：助手消息中的工具调用按顺序排成列表。
 *
 * - 每一步一行：左侧是状态图形（完成对勾、执行中缺口转圈、失败叉、等待空心圆、取消横杠），
 *   无纵向连接线；文字是“动作 + 对象”（如“读取 `src/a.ts`”），进行中的步骤文字流光；右侧是耗时或状态。
 * - 点击一行展开详情：参数与完整输出（可滚动）、截断说明、这条命令的沙箱。失败的错误不用展开就显示。
 * - `run_command` 用终端卡片（M2-06）：执行中直接显示实时输出，完成后展开显示；退出码不是 0 时默认展开。
 *   `read_file` 展开后用代码卡片显示读到的内容。其他工具执行中显示实时输出的最后几行。
 * - 文件类工具（读 / 写 / 编辑）的对象就是路径，点它直接在右侧工作台打开；修改过的文件自动显示 diff。
 * - 状态文字总在（完成时只给读屏），供读屏与测试使用。
 * - 组头默认折叠，只说最新一步在做什么（“运行 npm test”）并带上总耗时；
 *   失败、取消或等待审批时在组头点明卡在哪一步，但同样不自动展开。
 * - `edit_file` 完成后在文件名后面显示增删行数（`+2 −1`）。
 *
 * 不使用 `<p>`：消息流的测试按段落读取消息正文。
 */
import { Check, ChevronRight, Circle, LoaderCircle, Minus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ASK_USER_TOOL,
  CREATE_TASK_LIST_TOOL,
  PROPOSE_PLAN_TOOL,
  REVISE_PLAN_STEPS_TOOL,
  REVISE_TASK_ITEMS_TOOL,
  UPDATE_PLAN_STEP_TOOL,
  UPDATE_TASK_ITEM_TOOL,
  type LiveToolOutputView,
  type ToolCallView,
} from '@cairn/core'
import { translateError, type TFunction } from '@cairn/i18n'
import type { ContentPart, ToolCall } from '@cairn/protocol'
import { CodeCard } from './CodeCard.js'
import { ChangeCounts } from './DiffCard.js'
import { FileTypeIcon } from './file-icons.js'
import { formatDuration } from './format.js'
import { languageForPath } from './languages.js'
import { TerminalCard, type TerminalCardProps } from './TerminalCard.js'
import { parseReadFileOutput, parseRunCommandOutput } from './tool-results.js'
import { cn, Collapsible, CollapsibleContent, CollapsibleTrigger, Shimmer } from './ui/index.js'

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
  'ask_user',
])

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

/** 用户取消了 `ask_user` 的提问：结果里只有 `cancelled: true`。 */
export function isAskUserCancelled(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as { cancelled?: unknown }
    return parsed?.cancelled === true
  } catch {
    return false
  }
}

/** `ask_user` 的结果是结构化 JSON；展开时显示成“问题 → 回答”，不显示原始 JSON。 */
export function formatAskUserAnswers(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { answers?: unknown }
    if (!Array.isArray(parsed.answers)) return undefined
    return parsed.answers
      .flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as Record<string, unknown>
        const question = typeof record['question'] === 'string' ? record['question'] : ''
        const selected = Array.isArray(record['selected'])
          ? record['selected'].filter((value): value is string => typeof value === 'string')
          : []
        const custom = typeof record['custom'] === 'string' ? record['custom'] : ''
        const answer = [...selected, ...(custom === '' ? [] : [custom])].join(', ')
        return [`${question} → ${answer === '' ? '—' : answer}`]
      })
      .join('\n')
  } catch {
    return undefined
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

/**
 * 状态图形：完成是对勾、执行中是缺口转圈、失败是叉、等待是空心圆、取消是横杠。
 * 形状本身就说明状态，颜色只在完成（绿）和失败（红）上做辅助。
 */
export function ToolStatusIcon({
  status,
  exitCode,
  size = 13,
  className,
}: {
  readonly status: ToolCallView['status']
  readonly exitCode?: number | null | undefined
  readonly size?: number
  readonly className?: string
}) {
  const box = { width: size, height: size }
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    return (
      <X
        aria-hidden
        style={box}
        strokeWidth={2.6}
        className={cn('shrink-0 text-danger', className)}
      />
    )
  }
  switch (status) {
    case 'completed':
      return (
        <Check
          aria-hidden
          style={box}
          strokeWidth={2.8}
          className={cn('shrink-0 text-ok opacity-80', className)}
        />
      )
    case 'running':
      return (
        <LoaderCircle
          aria-hidden
          style={{ ...box, animationDuration: '1.4s' }}
          strokeWidth={2.4}
          className={cn('shrink-0 animate-spin text-accent', className)}
        />
      )
    case 'failed':
      return (
        <X
          aria-hidden
          style={box}
          strokeWidth={2.6}
          className={cn('shrink-0 text-danger', className)}
        />
      )
    case 'cancelled':
      return (
        <Minus
          aria-hidden
          style={box}
          strokeWidth={2.4}
          className={cn('shrink-0 text-faint', className)}
        />
      )
    default:
      return (
        <Circle
          aria-hidden
          style={box}
          strokeWidth={2}
          className={cn('shrink-0 text-faint opacity-55', className)}
        />
      )
  }
}

/** 一步工具的“动作 + 对象”，人话优先：参数按语义取字段，取不到才退回单行 JSON。 */
export interface ToolCallDescription {
  readonly action: string
  readonly object: string
  /** 对象不是路径或命令（计划、技能这类结构化参数），不用等宽字体。 */
  readonly plain: boolean
}

export function describeToolCall(name: string, args: unknown, t: TFunction): ToolCallDescription {
  const argsRecord =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  // 计划与待办列表工具的参数是结构化对象，直接抖 JSON 很丑；用一句人能读懂的话代替。
  const planTool =
    name === PROPOSE_PLAN_TOOL ||
    name === REVISE_PLAN_STEPS_TOOL ||
    name === UPDATE_PLAN_STEP_TOOL ||
    name === CREATE_TASK_LIST_TOOL ||
    name === REVISE_TASK_ITEMS_TOOL ||
    name === UPDATE_TASK_ITEM_TOOL
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
  } else if (name === CREATE_TASK_LIST_TOOL) {
    const title = argsRecord['title']
    action = t('tool.action.create_task_list')
    object = typeof title === 'string' && title !== '' ? title : summarizeInput(args)
  } else if (name === REVISE_TASK_ITEMS_TOOL) {
    const items = argsRecord['items']
    action = t('tool.action.revise_task_items')
    object = t('tool.taskItems', { count: Array.isArray(items) ? items.length : 0 })
  } else if (name === UPDATE_TASK_ITEM_TOOL) {
    action = t('tool.action.update_task_item')
    const itemId = typeof argsRecord['itemId'] === 'string' ? argsRecord['itemId'] : ''
    const itemStatus = argsRecord['status']
    const statusLabel =
      itemStatus === 'in_progress' || itemStatus === 'done' || itemStatus === 'skipped'
        ? t(`plan.step.${itemStatus}`)
        : ''
    object = [itemId, statusLabel].filter((part) => part !== '').join(' · ')
  } else if (name === ASK_USER_TOOL) {
    action = t('tool.action.ask_user')
    const questions = argsRecord['questions']
    const first =
      Array.isArray(questions) && typeof questions[0] === 'object' && questions[0] !== null
        ? (questions[0] as Record<string, unknown>)['question']
        : undefined
    object =
      typeof first === 'string'
        ? truncate(first.replace(/\s+/g, ' ').trim(), INPUT_SUMMARY_CHARS)
        : summarizeInput(args)
  } else {
    action = name === 'load_skill' ? '' : ACTIONS.has(name) ? t(`tool.action.${name}`) : name
    object = summarizeInput(args)
  }
  return { action, object, plain: name === 'load_skill' || planTool }
}

/** 能点开文件预览的工具：参数里的 `path` 就是右侧要打开的文件。 */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'write_file', 'edit_file'])

/**
 * `edit_file` 的结果里带着统一 diff：数出新增与删除的行，显示在文件名后面。
 * 只看 hunk 内部，`---` / `+++` 这类文件头不算改动。
 */
export function diffLineCounts(
  output: string,
): { readonly added: number; readonly removed: number } | undefined {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
    } else if (inHunk && line.startsWith('+')) {
      added += 1
    } else if (inHunk && line.startsWith('-')) {
      removed += 1
    }
  }
  return inHunk ? { added, removed } : undefined
}

/** 这一步对应的文件路径；不是文件类工具时返回 undefined。 */
export function filePathForTool(name: string, args: unknown): string | undefined {
  if (!FILE_TOOLS.has(name)) return undefined
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const path = record['path']
  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * 组头摘要：只说组里最新的一步在做什么，不罗列整组、也不补“等 N 项”。
 * 最新一步没有可说的内容时往前找最近一步；组里只有思考时返回 undefined，由调用方补一句“思考过程”。
 */
export function summarizeActivity(
  calls: readonly ToolCall[],
  tools: Readonly<Record<string, ToolCallView>>,
  t: TFunction,
): string | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (call === undefined) continue
    const { action, object } = describeToolCall(call.name, tools[call.id]?.input ?? call.input, t)
    const text = action === '' ? object : `${action} ${object}`
    if (text !== '') return text
  }
  return undefined
}

/** 组头右侧的耗时：组内各步耗时相加，没有耗时数据时不显示。 */
export function activityDuration(
  calls: readonly ToolCall[],
  tools: Readonly<Record<string, ToolCallView>>,
): string | undefined {
  const total = calls.reduce((sum, call) => sum + (tools[call.id]?.durationMs ?? 0), 0)
  return total > 0 ? formatDuration(total) : undefined
}

export interface ToolStepProps {
  readonly name: string
  /** 模型给出的参数（工具事件到达之前使用）。 */
  readonly input: unknown
  readonly tool: ToolCallView | undefined
  readonly live: LiveToolOutputView | undefined
  /** 这一步正在等待审批（右侧显示“等待审批”）。 */
  readonly awaitingApproval?: boolean
  /** 点击文件类工具的对象：在右侧工作台打开这个文件。 */
  readonly onOpenFile?: ((path: string) => void) | undefined
}

/** 时间线中的一步。 */
export function ToolStep({
  name,
  input,
  tool,
  live,
  awaitingApproval = false,
  onOpenFile,
}: ToolStepProps) {
  const { t, i18n } = useTranslation('session')
  const [openState, setOpen] = useState<boolean>()
  const status = tool?.status ?? 'requested'
  const args = tool?.input ?? input
  const running = status === 'running'
  const output = tool?.output ? outputText(tool.output) : ''
  const shownOutput =
    name === ASK_USER_TOOL
      ? (formatAskUserAnswers(output) ??
        (isAskUserCancelled(output) ? t('question.cancelled') : output))
      : output
  const terminal = name === 'run_command' ? terminalData(args, tool, live) : undefined
  const file =
    name === 'read_file' && status === 'completed' ? parseReadFileOutput(output) : undefined
  const open = openState ?? false
  const liveText = running && live && !terminal ? live.chunks.map((c) => c.text).join('') : ''
  const tail = liveText.trim() === '' ? undefined : previewLines(liveText, 'end')
  const { action, object, plain } = describeToolCall(name, args, t)
  /** 文件类工具的对象就是路径：点它直接在右侧工作台打开（修改过的文件自动显示 diff）。 */
  const filePath = filePathForTool(name, args)
  /** 编辑完成后的增删行数，跟在文件名后面。 */
  const changeStat =
    name === 'edit_file' && status === 'completed' ? diffLineCounts(output) : undefined
  const statusText =
    awaitingApproval && status === 'requested'
      ? t('tool.awaitingApproval')
      : t(`tool.status.${status}`)
  const exitCode = terminal?.exitCode
  const failedExit = exitCode !== undefined && exitCode !== null && exitCode !== 0
  const duration = tool?.durationMs === undefined ? undefined : formatDuration(tool.durationMs)
  /** 右侧只有一段灰字：退出码、耗时，或者状态。 */
  const meta =
    status === 'completed'
      ? failedExit
        ? t('terminal.exitCode', { code: exitCode })
        : (duration ?? '')
      : statusText

  return (
    <li className="relative">
      <section aria-label={t('message.toolCall', { name })} data-status={status}>
        <div className="group/step relative -mx-[7px] grid h-7 w-full grid-cols-[18px_auto_minmax(0,1fr)_auto_14px] items-center gap-x-[7px] rounded-[7px] px-[7px] text-left text-ui text-fg2 hover:bg-hover hover:text-fg">
          {/* 整行是展开开关；内容层不拦截点击，路径按钮单独浮在上面，点它去右侧打开文件。 */}
          <button
            type="button"
            aria-expanded={open}
            aria-label={t('tool.details', { name })}
            onClick={() => setOpen(!open)}
            className="absolute inset-0 cursor-pointer rounded-[7px] outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
          <span className="pointer-events-none flex items-center">
            <ToolStatusIcon status={status} exitCode={exitCode} />
          </span>
          {/* 动作列始终保留占位，技能这类没有动作词的工具才不会让后面几列整体左移。 */}
          <span className="pointer-events-none shrink-0">
            {action !== '' && <>{running ? <Shimmer>{action}</Shimmer> : action} </>}
          </span>
          <div className="pointer-events-none flex min-w-0 items-center gap-1.5">
            {filePath !== undefined && onOpenFile !== undefined ? (
              <button
                type="button"
                title={t('tool.openFile', { path: filePath })}
                onClick={() => onOpenFile(filePath)}
                className="pointer-events-auto relative z-10 flex w-fit min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-[4px] bg-sunk px-1 text-left font-mono text-[12px] text-fg2 outline-none hover:bg-press hover:text-fg focus-visible:ring-1 focus-visible:ring-accent"
              >
                <FileTypeIcon name={filePath} className="size-3" />
                <span className="min-w-0 truncate">
                  {running ? <Shimmer>{object}</Shimmer> : object}
                </span>
              </button>
            ) : (
              <code
                className={cn(
                  'pointer-events-none w-fit min-w-0 max-w-full truncate text-[12px] text-fg2',
                  plain ? 'font-sans' : 'rounded-[4px] bg-sunk px-1 font-mono',
                )}
              >
                {running ? <Shimmer>{object}</Shimmer> : object}
              </code>
            )}
            {changeStat && <ChangeCounts added={changeStat.added} removed={changeStat.removed} />}
          </div>
          <span
            className={cn(
              'pointer-events-none tabular shrink-0 text-note',
              status === 'failed' || failedExit ? 'text-danger' : 'text-faint',
            )}
          >
            {status === 'completed' && <span className="sr-only">{statusText} </span>}
            {meta}
          </span>
          <ChevronRight
            aria-hidden
            className={cn(
              'pointer-events-none size-3.5 shrink-0 text-faint transition-[transform,opacity] group-hover/step:text-fg',
              open ? 'rotate-90 opacity-100 text-fg' : 'opacity-0 group-hover/step:opacity-80',
            )}
          />
        </div>
        {tool?.error && (
          <div role="note" className="ml-[25px] text-note text-danger">
            {translateError(i18n, tool.error)}
          </div>
        )}
        {tail && (
          <div className="mt-1 ml-[25px] rounded-item bg-sunk px-3 py-2 font-mono text-[12px] text-fg2">
            {tail.omitted > 0 && (
              <div className="text-faint">{t('tool.earlierLines', { count: tail.omitted })}</div>
            )}
            <pre className="whitespace-pre-wrap break-all">{tail.lines}</pre>
          </div>
        )}
        {open && terminal && (
          <div className="mt-1 mb-2 ml-[25px] flex flex-col gap-1 text-note">
            <TerminalCard {...terminal} />
            {tool?.truncated && <div className="text-muted">{t('tool.truncated')}</div>}
          </div>
        )}
        {open && file && (
          <div className="mt-1 mb-2 ml-[25px] flex flex-col gap-1 text-note">
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
          <div className="mt-1 mb-2 ml-[25px] flex flex-col gap-2 text-note">
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
                  {shownOutput.replace(/\n+$/, '')}
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

/** 组头的一句话：折叠状态下说清这组做过什么；失败/取消/等待审批时点明卡在哪一步。 */
export interface ActivityHeadline {
  readonly tone: 'running' | 'attention' | 'waiting' | 'cancelled' | 'done'
  readonly label: string
  /** 对象（命令、路径、计划目标…）。 */
  readonly object?: string | undefined
  /** 对象不是路径或命令（计划、技能这类结构化参数），不用等宽字体。 */
  readonly plain?: boolean | undefined
  /** 失败/取消时读作「命令 + 失败」，对象在前。 */
  readonly objectFirst?: boolean | undefined
  /** 右侧的耗时（如 `8.3s`）。 */
  readonly meta?: string | undefined
}

/** 组头（整行、无边框、悬停变底色）：与步骤行共用 18px 图标列与 7px 间距。 */
export const ACTIVITY_TRIGGER_CLASS =
  '-mx-[7px] flex h-[30px] w-full cursor-pointer select-none items-center gap-x-[7px] rounded-[7px] px-[7px] text-left text-ui text-fg2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent'

export function ActivityGroupHeaderContent({
  headline,
  open,
  shimmer = false,
}: {
  readonly headline: ActivityHeadline
  readonly open: boolean
  /** 执行中的文字流光。 */
  readonly shimmer?: boolean
}) {
  const status: ToolCallView['status'] =
    headline.tone === 'done'
      ? 'completed'
      : headline.tone === 'attention'
        ? 'failed'
        : headline.tone === 'cancelled'
          ? 'cancelled'
          : headline.tone === 'waiting'
            ? 'requested'
            : 'running'
  const object =
    headline.object === undefined || headline.object === '' ? null : (
      <code
        className={cn(
          'min-w-0 truncate text-[12px] text-fg2',
          headline.plain ? 'font-sans' : 'rounded-[4px] bg-sunk px-1 font-mono',
        )}
      >
        {headline.object}
      </code>
    )
  const label = (
    <span className={cn('min-w-0 truncate', headline.tone === 'attention' && 'text-danger')}>
      {shimmer ? <Shimmer>{headline.label}</Shimmer> : headline.label}
    </span>
  )
  return (
    <>
      <span className="flex w-[18px] shrink-0 items-center">
        <ToolStatusIcon status={status} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-x-[7px] text-[13px] font-medium">
        {headline.objectFirst ? (
          <>
            {object} {label}
          </>
        ) : (
          <>
            {label}
            {object === null ? null : ' '}
            {object}
          </>
        )}
      </span>
      {headline.meta !== undefined && headline.meta !== '' && (
        <span className="tabular shrink-0 text-note text-faint">{headline.meta}</span>
      )}
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 text-faint transition-transform duration-150',
          open ? 'rotate-90 text-fg2' : 'opacity-70',
        )}
      />
    </>
  )
}

/** 一条助手消息中的工具调用：运行中和异常时展示步骤，正常结束后收起为摘要。 */
export function ToolTimeline({
  children,
  count,
  running,
  attention = false,
  headline,
}: {
  readonly children: ReactNode
  /** 省略时保持原来的逐条展示（也供独立工具卡片使用）。 */
  readonly count?: number
  readonly running?: boolean
  readonly attention?: boolean
  /** 组头的一句话；省略时退回计数式文案。 */
  readonly headline?: ActivityHeadline | undefined
}) {
  const { t } = useTranslation('session')
  const [openState, setOpenState] = useState<boolean>()
  // 一律默认折叠，状态变化也不自动展开：只有用户点过组头才展开。
  const open = openState ?? false
  // 嵌在归组里时不留外边距：每一步 28px，行与行无缝接上（间距由归组容器负责）。
  const steps = <ol className={cn('flex flex-col', count !== undefined && 'mt-0.5')}>{children}</ol>
  if (count === undefined) return steps

  const shown: ActivityHeadline = headline ?? {
    tone: running ? 'running' : attention ? 'attention' : 'done',
    label: t(
      running ? 'tool.group.running' : attention ? 'tool.group.attention' : 'tool.group.done',
      { steps: count },
    ),
  }

  return (
    <Collapsible open={open} onOpenChange={setOpenState} className="my-2">
      <CollapsibleTrigger data-tool-group className={ACTIVITY_TRIGGER_CLASS}>
        <ActivityGroupHeaderContent
          headline={shown}
          open={open}
          shimmer={shown.tone === 'running'}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>{steps}</CollapsibleContent>
    </Collapsible>
  )
}
