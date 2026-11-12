/**
 * 新对话首页与会话内输入框共用的指令逻辑（#163 之后的对齐）。
 *
 * 会话页可以把 `/files` 等指令交给右侧面板，新对话页还没有会话，只能识别 `/plan`；
 * 两边共用「可用指令 → 面板 → 草稿解析 → 发送参数」这段代码，避免新对话页漏掉技能、
 * 高亮和发送时的 skills 负载。
 */
import type { SkillSummary } from '@cairn/protocol'
import {
  COMPOSER_COMMANDS,
  composerCommandQuery,
  filterComposerCommands,
  parseComposerCommand,
  type ComposerCommandArgs,
} from './composer-commands.js'
import { mentionText } from './composer-tokens.js'
import type { SessionPanel } from './SessionPanels.js'
import type { SettingsSection } from './settings/SettingsPage.js'

export interface AvailableComposerCommand {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly args: ComposerCommandArgs
  readonly kind: 'command' | 'skill'
  readonly skill?: string | undefined
  readonly panel?: SessionPanel | undefined
  readonly unavailable?: string | undefined
}

export interface CommandActions {
  /** 运行中执行某些指令时不可用；新对话页省略。 */
  readonly active?: boolean | undefined
  /** `/files` 等打开右侧面板；没有时这些指令不出现。 */
  readonly onOpenPanel?: ((panel: SessionPanel) => void) | undefined
  /** `/new`；没有时指令不出现。 */
  readonly onNewChat?: (() => void) | undefined
  /** `/settings`；没有时指令不出现。 */
  readonly onOpenSettings?: ((section: SettingsSection) => void) | undefined
  readonly modelMenuDisabled?: boolean | undefined
  /** 有可撤销的轮次；没有时 `/undo` 不可用。 */
  readonly undoAvailable?: boolean | undefined
}

/**
 * 内置指令 + 已启用的项目 / 本机技能。新对话页只保留能在会话创建前执行的指令：
 * `/plan` 和技能；其余指令要等会话与右侧工作台存在之后才有意义。
 */
export function availableCommands(
  skills: readonly SkillSummary[],
  t: (key: string) => string,
  actions: CommandActions = {},
  includeSessionCommands = true,
): readonly AvailableComposerCommand[] {
  const commands: AvailableComposerCommand[] = COMPOSER_COMMANDS.filter((command) => {
    if (!includeSessionCommands) return command.id === 'plan'
    if (command.panel !== undefined) return actions.onOpenPanel !== undefined
    if (command.id === 'new') return actions.onNewChat !== undefined
    if (command.id === 'settings') return actions.onOpenSettings !== undefined
    return true
  }).map((command) => ({
    ...command,
    kind: 'command' as const,
    description: t(command.descriptionKey),
    unavailable:
      command.idleOnly === true && actions.active === true
        ? 'composer.command.unavailable.running'
        : command.id === 'model' && actions.modelMenuDisabled === true
          ? 'composer.command.unavailable.model'
          : command.id === 'undo' && actions.undoAvailable !== true
            ? 'composer.command.unavailable.undo'
            : undefined,
  }))
  return [
    ...commands,
    ...skills
      .filter((skill) => skill.enabled && !skill.shadowed)
      .map((skill) => ({
        id: `skill:${skill.name}`,
        name: skill.name,
        description: skill.description,
        args: 'text' as const,
        kind: 'skill' as const,
        skill: skill.name,
      })),
  ]
}

/** 面板只在草稿是一个 `/` 词时打开，按「内置 / 技能」分组并依相关度排序。 */
export function commandPanel(
  text: string,
  commands: readonly AvailableComposerCommand[],
  dismissed: string | null,
  index: number,
): {
  readonly open: boolean
  readonly query: string | null
  readonly filtered: readonly AvailableComposerCommand[]
  readonly activeIndex: number
} {
  const query = composerCommandQuery(text)
  const open = query !== null && dismissed !== text
  const filtered =
    query === null || !open
      ? []
      : [
          ...filterComposerCommands(
            commands.filter((command) => command.kind === 'command'),
            query,
          ),
          ...filterComposerCommands(
            commands.filter((command) => command.kind === 'skill'),
            query,
          ),
        ]
  return {
    open,
    query,
    filtered,
    activeIndex: filtered.length === 0 ? -1 : Math.min(index, filtered.length - 1),
  }
}

export interface ParsedPrompt {
  /** 去掉 `/技能名` 或 `/plan 任务` 之后要发送的任务描述。 */
  readonly draft: string
  readonly plan: boolean
  /** `/技能名` 选中时随第一条消息一起发出。 */
  readonly skills: readonly string[]
  /** `/plan` 不带任务时只切换计划模式，不创建会话。 */
  readonly toggleOnly: boolean
  /** 只补全草稿为 `/技能名 `，不发送（技能后面还需要任务描述）。 */
  readonly complete?: string
}

/**
 * 解析发送动作：普通草稿、`/plan 任务`、`/技能名 任务`。未知 `/xxx` 按普通消息发送。
 * 新对话页传递 `planMode`，会话页由指令执行器处理其余指令。
 */
export function parsePrompt(
  text: string,
  commands: readonly AvailableComposerCommand[],
  planMode: boolean,
): ParsedPrompt {
  const parsed = parseComposerCommand(text, commands)
  if (parsed?.command.id === 'plan' && parsed.args === '') {
    return { draft: '', plan: !planMode, skills: [], toggleOnly: true }
  }
  if (parsed?.command.id === 'plan') {
    return { draft: parsed.args, plan: true, skills: [], toggleOnly: false }
  }
  if (parsed?.command.kind === 'skill') {
    return parsed.args === ''
      ? {
          draft: '',
          plan: planMode,
          skills: [],
          toggleOnly: false,
          complete: `/${parsed.command.name} `,
        }
      : {
          draft: parsed.args,
          plan: planMode,
          skills: [parsed.command.name],
          toggleOnly: false,
        }
  }
  return { draft: text, plan: planMode, skills: [], toggleOnly: false }
}

/** 把拖进来或选中的路径插到光标处：选中位置被引用替换，光标落在引用后面。 */
export function insertMention(
  text: string,
  start: number,
  end: number,
  path: string,
  kind: 'file' | 'dir',
): { readonly text: string; readonly caret: number } {
  const inserted = mentionText(path, kind)
  return { text: text.slice(0, start) + inserted + text.slice(end), caret: start + inserted.length }
}
