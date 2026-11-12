/**
 * 新对话首页（对齐 LiveAgent）：上方是应用标志与随时段变化的问候，输入框像对话页一样贴在底部，
 * 工作空间与分支显示在输入框上方。发送时先用当前工作空间创建会话，再把这条输入作为第一轮发送。
 * 还没有工作空间时可以打开本地文件夹。输入 `@` 可以引用所选工作空间里的文件（ADR-0037）。
 *
 * 输入体验与会话内的输入框一致（对齐两者的输入体验）：同样支持 `/plan` 与 `/技能名`、
 * 指令面板、高亮层、拖入文件引用；区别只是会话还不存在，所以只有 `/plan` 和技能出现在面板里。
 */
import { ArrowUp } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelRef, SkillSummary } from '@cairn/protocol'
import {
  enabledModelChoices,
  ModelPicker,
  PermissionMenu,
  resolveDefaultModel,
  sameModel,
  PlanModeChip,
} from './Composer.js'
import { COMMAND_LIST_ID, commandOptionId, ComposerCommandList } from './ComposerCommandList.js'
import { ComposerHighlight } from './ComposerHighlight.js'
import {
  availableCommands,
  commandPanel,
  insertMention,
  parsePrompt,
  type AvailableComposerCommand,
  type ParsedPrompt,
} from './composer-shared.js'
import { extractAgents } from './composer-tokens.js'
import { FILE_DRAG_TYPE, draggedFile } from './file-drag.js'
import { MENTION_LIST_ID, useMentionMenu, type MentionAgent } from './ComposerMentions.js'
import { agentName, localized } from './agents/model.js'
import { isPlanModeKey } from './layout/shortcuts.js'
import { useSessionStore } from './store-context.js'
import { WorkspaceGitBar } from './WorkspaceGitBar.js'
import { CairnMark, cn } from './ui/index.js'

/** 文本框最高（px），超过后滚动。 */
const MAX_TEXTAREA_HEIGHT = 200
/** 用首行输入生成会话标题，避免侧栏里全是“未命名会话”。 */
const MAX_TITLE_LENGTH = 60

type GreetingPeriod = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night'

export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

function useGreetingPeriod(): GreetingPeriod {
  const [period, setPeriod] = useState<GreetingPeriod>(() => greetingPeriod(new Date().getHours()))

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPeriod(greetingPeriod(new Date().getHours()))
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return period
}

function titleFromPrompt(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return firstLine.slice(0, MAX_TITLE_LENGTH).trim()
}

export function NewSession({
  initialProjectPath,
  onDone,
}: {
  /** 从某个工作空间的“新建会话”进入时预先选中的项目路径。 */
  readonly initialProjectPath?: string | undefined
  /** 会话创建并发出第一条消息后离开新对话页。 */
  readonly onDone: () => void
}) {
  const { t, i18n } = useTranslation('session')
  const createSession = useSessionStore((s) => s.createSession)
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const listSkills = useSessionStore((s) => s.listSkills)
  const projects = useSessionStore((s) => s.projects)
  const agents = useSessionStore((s) => s.agents) ?? []
  const delegationTargets = useSessionStore((s) => s.delegationTargets)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const openProject = useSessionStore((s) => s.openProject)
  const providers = useSessionStore((s) => s.settings?.providers) ?? []
  const defaultModel = useSessionStore((s) => s.settings?.defaultModel)
  const hasModel = enabledModelChoices(providers).length > 0
  const [projectPath, setProjectPath] = useState(initialProjectPath ?? projects[0]?.path ?? '')
  const [selectedModel, setSelectedModel] = useState<ModelRef | undefined>()
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [skills, setSkills] = useState<readonly SkillSummary[]>([])
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const projectId = projects.find((project) => project.path === projectPath.trim())?.projectId
  /** 新会话的 `@Agent` 只能点名默认 Agent 的委派名单（M4-02）。 */
  const [delegateIds, setDelegateIds] = useState<readonly string[]>()
  useEffect(() => {
    let alive = true
    void delegationTargets(undefined).then((targets) => {
      if (alive)
        setDelegateIds(targets === undefined ? undefined : targets.enabled ? targets.agentIds : [])
    })
    return () => {
      alive = false
    }
  }, [delegationTargets])
  const agentOptions = useMemo<MentionAgent[]>(
    () =>
      agents
        .filter((agent) => delegateIds === undefined || delegateIds.includes(agent.agentId))
        .map((agent) => ({
          agentId: agent.agentId,
          name: agentName(agent, i18n.language),
          description: localized(agent.description, i18n.language, ''),
        })),
    [agents, delegateIds, i18n.language],
  )
  const agentMentions = useMemo(() => {
    const byName = new Map<string, { agentId: string; name: string }>()
    for (const agent of agents) {
      if (delegateIds !== undefined && !delegateIds.includes(agent.agentId)) continue
      for (const candidate of [agent.name['zh-CN'], agent.name['en-US']]) {
        const name = candidate?.trim()
        if (name !== undefined && name !== '') byName.set(name, { agentId: agent.agentId, name })
      }
    }
    return [...byName.values()]
  }, [agents, delegateIds])
  const mention = useMentionMenu({
    text,
    setText,
    textarea,
    root: box,
    scope: projectId === undefined ? undefined : { projectId },
    agents: agentOptions,
    disabled: busy,
  })
  const period = useGreetingPeriod()
  const model = selectedModel ?? resolveDefaultModel(providers, defaultModel)

  // 新对话页还没有会话，只有 `/plan` 和技能能在创建会话前执行。
  const commands: readonly AvailableComposerCommand[] = availableCommands(skills, t, {}, false)
  const commandNames = commands.map((command) => command.name)
  const panel = commandPanel(text, commands, dismissedDraft, commandIndex)
  const commandPanelOpen = !mention.open && panel.open && !busy
  const filteredCommands = commandPanelOpen ? panel.filtered : []
  const activeCommandIndex = panel.activeIndex

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    textarea.current?.focus()
  }, [])

  // 技能列表：项目里的技能随工作空间变化，本机与全局技能始终可用。
  useEffect(() => {
    let alive = true
    void listSkills(projectId).then((list) => {
      if (alive) setSkills(list ?? [])
    })
    return () => {
      alive = false
    }
  }, [listSkills, projectId])

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [text])

  useEffect(() => {
    if (initialProjectPath !== undefined) setProjectPath(initialProjectPath)
  }, [initialProjectPath])

  // 项目列表比页面晚到时补上默认目录；已经选中的内容不覆盖。
  useEffect(() => {
    if (initialProjectPath !== undefined) return
    setProjectPath((current) => (current === '' ? (projects[0]?.path ?? '') : current))
  }, [initialProjectPath, projects])

  useEffect(() => {
    setCommandIndex(0)
    // 离开 `/` 草稿后忘掉这次关闭，下一次重新输入 `/` 时面板还会打开。
    if (panel.query === null) setDismissedDraft(null)
  }, [panel.query])

  // 点击输入框以外的地方关闭指令面板，避免它一直挂在输入框上方。
  useEffect(() => {
    if (!commandPanelOpen) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (box.current?.contains(event.target) === true) return
      setDismissedDraft(text)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [commandPanelOpen, text])

  const chooseFolder = async () => {
    const project = await openProject()
    if (project) setProjectPath(project.path)
  }

  /** 把拖进来的文件插到光标处，等同于选中一个 `@` 候选。 */
  const insertReference = (path: string, kind: 'file' | 'dir') => {
    const element = textarea.current
    const start = element?.selectionStart ?? text.length
    const end = element?.selectionEnd ?? start
    const next = insertMention(text, start, end, path, kind)
    setText(next.text)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(next.caret, next.caret)
    })
  }

  /** 创建会话并发出第一轮。`parsed` 来自共享的草稿解析，两边行为一致。 */
  const sendParsed = async (parsed: ParsedPrompt) => {
    const path = projectPath.trim()
    const draft = parsed.draft.trim()
    if (path === '' || draft === '' || busy || model === undefined) return
    setBusy(true)
    const sessionId = await createSession(path, titleFromPrompt(draft) || undefined)
    if (sessionId === undefined) {
      setBusy(false)
      return
    }
    // 新会话先按模型创建，再切换用户选的模型，最后才发出第一轮。
    if (!sameModel(model, defaultModel)) await setSessionModel(sessionId, model)
    await sendPrompt(draft, parsed.plan ? 'plan' : 'normal', {
      agents: extractAgents(draft, agentMentions),
      agentNames: agentMentions.map((item) => item.name),
      skills: [...parsed.skills],
    })
    setBusy(false)
    onDone()
  }

  const send = async () => {
    const parsed = parsePrompt(text, commands, planMode)
    // `/plan` 单独出现只切换计划模式，`/技能名` 单独出现只补全，都不创建会话。
    if (parsed.toggleOnly) {
      setPlanMode(parsed.plan)
      setText('')
      return
    }
    if (parsed.complete !== undefined) {
      setText(parsed.complete)
      textarea.current?.focus()
      return
    }
    await sendParsed(parsed)
  }

  /** 执行面板里高亮的指令。 */
  const runCommand = (command: AvailableComposerCommand) => {
    if (command.unavailable !== undefined) return
    setDismissedDraft(null)
    if (command.kind === 'skill') {
      // 技能后面还要写任务描述：先补全成 `/名称 `，不创建会话。
      setText(`/${command.name} `)
      textarea.current?.focus()
      return
    }
    if (command.id === 'plan') {
      setText('')
      setPlanMode((on) => !on)
      textarea.current?.focus()
    }
  }

  // Ctrl+Shift+P / ⌘⇧P 与会话输入框一致：切换计划模式；对话框和菜单打开时交给它们。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlanModeKey(event) || event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
        )
      )
        return
      event.preventDefault()
      setPlanMode((on) => !on)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const submit = () => {
    // 面板打开时点发送键等同于执行当前高亮的指令，而不是把 `/plan` 当消息发出去。
    const command = commandPanelOpen ? filteredCommands[activeCommandIndex] : undefined
    if (command !== undefined) {
      runCommand(command)
      return
    }
    void send()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字时的 Enter 属于候选词确认，不执行命令、也不发送。
    if (event.key === 'Enter' && event.nativeEvent.isComposing) return
    if (mention.onKeyDown(event)) return
    if (commandPanelOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (filteredCommands.length === 0) return
        event.preventDefault()
        setCommandIndex((current) => {
          const base = Math.min(current, filteredCommands.length - 1)
          const next = event.key === 'ArrowDown' ? base + 1 : base - 1
          return (next + filteredCommands.length) % filteredCommands.length
        })
        return
      }
      if (event.key === 'Tab' && !event.shiftKey) {
        const command = filteredCommands[activeCommandIndex]
        if (command === undefined) return
        event.preventDefault()
        setText(command.args === 'none' ? `/${command.name}` : `/${command.name} `)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedDraft(text)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const command = filteredCommands[activeCommandIndex]
        if (command !== undefined) {
          event.preventDefault()
          runCommand(command)
          return
        }
        // 没有匹配时按普通消息发送。
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6">
        <div className="relative mb-7 grid size-20 place-items-center">
          <span aria-hidden className="absolute inset-0 rounded-full bg-accent-soft blur-2xl" />
          <CairnMark size={72} className="relative text-fg" />
        </div>
        <p className="text-center text-[26px] leading-[1.2] font-semibold tracking-[-0.02em] text-fg">
          {t(`new.greeting.${period}`)}
        </p>
        <p className="mt-2 text-center text-note text-muted">{t('new.greetingSubtitle')}</p>
      </div>

      <div className="mx-auto w-full max-w-[880px] shrink-0 px-5 pb-4 min-[1200px]:px-8">
        <WorkspaceGitBar
          projectPath={projectPath === '' ? undefined : projectPath}
          projects={projects}
          onSelectProject={setProjectPath}
          onOpenFolder={() => void chooseFolder()}
        />
        <div ref={box} className="relative">
          {mention.list}
          {commandPanelOpen && (
            <ComposerCommandList
              commands={filteredCommands}
              activeIndex={activeCommandIndex}
              onSelect={runCommand}
              onHover={setCommandIndex}
            />
          )}
          <div
            onDragOver={(event) => {
              if (busy || !event.dataTransfer.types.includes(FILE_DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setDragging(false)
            }}
            onDrop={(event) => {
              setDragging(false)
              const file = draggedFile(event)
              if (busy || file === undefined) return
              event.preventDefault()
              insertReference(file.path, file.kind)
            }}
            className={cn(
              'rounded-[16px] border border-hair2 bg-raise px-4 pt-3.5 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60',
              dragging && 'border-accent ring-2 ring-accent/20',
            )}
          >
            <div className="relative">
              <textarea
                ref={textarea}
                rows={2}
                aria-label={t('input.label')}
                placeholder={planMode ? t('composer.plan.placeholder') : t('new.placeholder')}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={keyDown}
                onSelect={mention.onCaret}
                aria-expanded={commandPanelOpen || mention.open}
                aria-controls={
                  mention.open ? MENTION_LIST_ID : commandPanelOpen ? COMMAND_LIST_ID : undefined
                }
                aria-activedescendant={
                  mention.open
                    ? mention.activeId
                    : commandPanelOpen && activeCommandIndex >= 0
                      ? commandOptionId(filteredCommands[activeCommandIndex]!)
                      : undefined
                }
                className="relative block max-h-[200px] min-h-12 w-full resize-none break-words bg-transparent px-1 text-body text-transparent caret-fg outline-none placeholder:text-faint"
              />
              {/* 放在文本框之后：它的布局副作用要等文本框的 ref 就绪 */}
              <ComposerHighlight
                text={text}
                commands={commandNames}
                textarea={textarea}
                className="px-1 text-body text-fg break-words"
              />
            </div>
            <div className="mt-2 flex items-center gap-1">
              <PermissionMenu />
              <PlanModeChip on={planMode} onExit={() => setPlanMode(false)} />
              <div className="ml-auto flex min-w-0 items-center gap-1">
                <ModelPicker
                  providers={providers}
                  model={model}
                  fixed={false}
                  disabled={!hasModel}
                  open={modelMenuOpen}
                  onOpenChange={setModelMenuOpen}
                  onSelect={setSelectedModel}
                />
                <button
                  type="button"
                  aria-label={t('input.send')}
                  title={t('input.send')}
                  disabled={
                    busy || projectPath.trim() === '' || text.trim() === '' || model === undefined
                  }
                  onClick={submit}
                  className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-25"
                >
                  <ArrowUp className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
