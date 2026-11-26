/**
 * 新对话首页（对齐 LiveAgent）：上方是应用标志与随时段变化的问候，输入框像对话页一样贴在底部，
 * 工作空间与分支显示在输入框上方。发送时先用当前工作空间创建会话，再把这条输入作为第一轮发送。
 * 还没有工作空间时可以打开本地文件夹。输入 `@` 可以引用所选工作空间里的文件（ADR-0037）。
 *
 * 输入体验与会话内的输入框一致（对齐两者的输入体验）：同样支持 `/plan` 与 `/技能名`、
 * 指令面板、高亮层、拖入文件引用；区别只是会话还不存在，所以只有 `/plan` 和技能出现在面板里。
 */
import { ArrowUp } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { BUILTIN_CODER_ID } from '@cairn/core'
import type { ModelRef, SkillSummary } from '@cairn/protocol'
import {
  enabledModelChoices,
  ModelPicker,
  PermissionMenu,
  resolveDefaultModel,
  sameModel,
  PlanModeChip,
} from './Composer.js'
import { AgentPicker, availableAgents, availableTeams } from './agents/AgentPicker.js'
import { COMMAND_LIST_ID, commandOptionId, ComposerCommandList } from './ComposerCommandList.js'
import {
  clearComposerDraft,
  NEW_SESSION_DRAFT_KEY,
  readComposerDraft,
  readNewSessionAgent,
  readNewSessionModel,
  readNewSessionProject,
  readNewSessionTeam,
  writeComposerDraft,
  writeNewSessionAgent,
  writeNewSessionModel,
  writeNewSessionProject,
  writeNewSessionTeam,
} from './composer-drafts.js'
import { ComposerHighlight } from './ComposerHighlight.js'
import {
  availableCommands,
  commandPanel,
  insertMention,
  parsePrompt,
  sessionOnlyCommand,
  type AvailableComposerCommand,
  type ParsedPrompt,
} from './composer-shared.js'
import { extractAgents } from './composer-tokens.js'
import {
  FILE_DRAG_TYPE,
  draggedFile,
  externalDroppedFiles,
  pastedFilePaths,
  relativeMentionPath,
  type ExternalFile,
} from './file-drag.js'
import { onIdle } from './idle.js'
import { MENTION_LIST_ID, useMentionMenu, type MentionAgent } from './ComposerMentions.js'
import { agentName, localized } from './agents/model.js'
import { mark, markReady } from './startup-trace.js'
import { COMPOSER_FOCUS_EVENT, isPlanModeKey } from './layout/shortcuts.js'
import type { SettingsSection } from './settings/SettingsPage.js'
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
  onCreatingChange,
  onOpenSettings,
  onDone,
}: {
  /** 从某个工作空间的“新建会话”进入时预先选中的项目路径。 */
  readonly initialProjectPath?: string | undefined
  /**
   * 开始 / 结束创建会话。创建期间会话已经选中，但第一条消息还没发出，
   * 外层据此留在这一页，避免闪一下空的消息区。
   */
  readonly onCreatingChange?: ((creating: boolean) => void) | undefined
  /** 选择器底部的“管理 Agents”跳到设置；没有时入口不显示。 */
  readonly onOpenSettings?: ((section: SettingsSection) => void) | undefined
  /** 会话创建并发出第一条消息后离开新对话页。 */
  readonly onDone: () => void
}) {
  const { t, i18n } = useTranslation('session')
  const createSession = useSessionStore((s) => s.createSession)
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const setSessionAgent = useSessionStore((s) => s.setSessionAgent)
  const setSessionTeam = useSessionStore((s) => s.setSessionTeam)
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const listSkills = useSessionStore((s) => s.listSkills)
  const projects = useSessionStore((s) => s.projects)
  const agents = useSessionStore((s) => s.agents) ?? []
  const teams = useSessionStore((s) => s.teams) ?? []
  const delegationTargets = useSessionStore((s) => s.delegationTargets)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const openProject = useSessionStore((s) => s.openProject)
  const providers = useSessionStore((s) => s.settings?.providers) ?? []
  const defaultModel = useSessionStore((s) => s.settings?.defaultModel)
  const hasModel = enabledModelChoices(providers).length > 0
  /**
   * 进入页面时恢复上次的状态：显式指定的工作空间优先，其次是上次用过的，最后是项目列表里
   * 第一个；模型与 Agent 按工作空间分别记住，草稿与计划模式整页共用。
   */
  const [restored] = useState(() => {
    const path = initialProjectPath ?? readNewSessionProject() ?? projects[0]?.path ?? ''
    const teamId = readNewSessionTeam(path)
    return {
      path,
      model: readNewSessionModel(path),
      // 团队与单个 Agent 只记一个：选中团队时忽略旧的 Agent。
      teamId,
      agentId: teamId === undefined ? readNewSessionAgent(path) : undefined,
      draft: readComposerDraft(NEW_SESSION_DRAFT_KEY),
    }
  })
  const [projectPath, setProjectPath] = useState(restored.path)
  const [selectedModel, setSelectedModel] = useState<ModelRef | undefined>(restored.model)
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(restored.agentId)
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>(restored.teamId)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [planMode, setPlanMode] = useState(restored.draft.planMode)
  const [text, setText] = useState(restored.draft.text)
  const [busy, setBusy] = useState(false)
  const [skills, setSkills] = useState<readonly SkillSummary[]>([])
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 输入了只有会话内才能用的 `/goal`：提示先创建会话，不发送。 */
  const [sessionOnlyNotice, setSessionOnlyNotice] = useState(false)
  /** 拖入 / 粘贴文件的提示（工作空间外、未选工作空间等）。 */
  const [dropNotice, setDropNotice] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const projectId = projects.find((project) => project.path === projectPath.trim())?.projectId
  /** 新会话的 `@Agent` 跟随所选团队主控 / Agent 的委派名单（M4-02）。 */
  const [delegateIds, setDelegateIds] = useState<readonly string[]>()
  const agentOptions = useMemo<MentionAgent[]>(
    () =>
      agents
        .filter(
          (agent) =>
            !agent.archived && (delegateIds === undefined || delegateIds.includes(agent.agentId)),
        )
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
      if (agent.archived) continue
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
  const selectableAgents = useMemo(() => availableAgents(agents), [agents])
  // 记住的 Agent 可能已经归档或删除：找不到就回到主进程的默认 Agent（内置编程助手）。
  const selectedAgent = useMemo(
    () => selectableAgents.find((agent) => agent.agentId === selectedAgentId),
    [selectableAgents, selectedAgentId],
  )
  // 团队模板由应用启动时读入；主控的固定模型要在发送前生效。
  const selectableTeams = useMemo(() => availableTeams(teams), [teams])
  // 记住的团队可能已经归档、删除或不再有已发布版本：找不到就回到单个 Agent。
  const selectedTeam = useMemo(
    () => selectableTeams.find((team) => team.teamId === selectedTeamId),
    [selectableTeams, selectedTeamId],
  )
  // 还没创建会话：按选中的团队主控 / Agent 计算 `@Agent` 候选；都没选时用默认 Agent。
  useEffect(() => {
    let alive = true
    const selection =
      selectedTeam !== undefined
        ? { teamId: selectedTeam.teamId }
        : selectedAgent === undefined
          ? undefined
          : { agent: { id: selectedAgent.agentId, version: selectedAgent.version } }
    void delegationTargets(undefined, selection).then((targets) => {
      if (alive)
        setDelegateIds(targets === undefined ? undefined : targets.enabled ? targets.agentIds : [])
    })
    return () => {
      alive = false
    }
  }, [delegationTargets, selectedAgent, selectedTeam])
  /** 固定模型的 Agent 由它决定模型；选中团队时按主控 Agent 算。 */
  const selectedDefinition = useMemo(
    () =>
      selectedTeam === undefined
        ? selectedAgent
        : agents.find((agent) => agent.agentId === selectedTeam.coordinator),
    [agents, selectedAgent, selectedTeam],
  )
  const fixedModel =
    selectedDefinition?.modelMode === 'fixed' ? selectedDefinition.model : undefined
  // 上次选的模型可能已被停用：校验不通过时退回设置里的默认模型（或第一个可用模型）。
  const model = fixedModel ?? resolveDefaultModel(providers, selectedModel ?? defaultModel)
  /** 欢迎页的建议提示词。 */
  const suggestions = [1, 2, 3].map((index) => t(`new.suggestion.${index}`))

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
    // 首屏可交互：输入框已获得焦点。e2e 依赖这个属性等待启动完成。
    mark('new_session_ready')
    markReady()
  }, [])

  // ⌘L：根组件派发聚焦请求，由当前挂载的输入框响应。
  useEffect(() => {
    const onFocus = () => textarea.current?.focus()
    window.addEventListener(COMPOSER_FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, onFocus)
  }, [])

  /** 技能列表只在输入 `/` 或空闲时才需要；首帧不扫描磁盘。 */
  const requestSkills = () => {
    void listSkills(projectId).then((list) => setSkills(list ?? []))
  }

  // 技能列表：项目里的技能随工作空间变化，本机与全局技能始终可用。首帧之后读取。
  useEffect(() => {
    let alive = true
    const cancel = onIdle(() => {
      void listSkills(projectId).then((list) => {
        if (alive) setSkills(list ?? [])
      })
    }, 1000)
    return () => {
      alive = false
      cancel()
    }
  }, [listSkills, projectId])

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [text])

  /** 切换工作空间：模型、Agent 与团队也换成那个工作空间上次选的，并记住这次的工作空间。 */
  const changeProject = useCallback((path: string) => {
    const teamId = readNewSessionTeam(path)
    setProjectPath(path)
    setSelectedModel(readNewSessionModel(path))
    setSelectedTeamId(teamId)
    setSelectedAgentId(teamId === undefined ? readNewSessionAgent(path) : undefined)
    writeNewSessionProject(path)
  }, [])

  useEffect(() => {
    if (initialProjectPath !== undefined) changeProject(initialProjectPath)
  }, [initialProjectPath, changeProject])

  // 项目列表比页面晚到时补上默认目录；上次用过的目录已不在列表里时也退回第一个。
  useEffect(() => {
    if (initialProjectPath !== undefined || projects.length === 0) return
    if (projectPath !== '' && projects.some((project) => project.path === projectPath)) return
    changeProject(projects[0]!.path)
  }, [changeProject, initialProjectPath, projects, projectPath])

  // 拖入 / 粘贴文件的提示自动消失。
  useEffect(() => {
    if (dropNotice === null) return
    const timer = setTimeout(() => setDropNotice(null), 3_500)
    return () => clearTimeout(timer)
  }, [dropNotice])

  // 草稿与计划模式随输入实时记下：去设置页再回来时输入框是重新挂载的，据此恢复。
  useEffect(() => {
    writeComposerDraft(NEW_SESSION_DRAFT_KEY, { text, planMode })
  }, [text, planMode])

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
    if (project) changeProject(project.path)
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

  /** 把外部拖入 / 粘贴的绝对路径转成相对引用，插到光标处。 */
  const insertExternalFiles = (files: readonly ExternalFile[]) => {
    const root = projectPath.trim()
    if (root === '') {
      setDropNotice('input.needWorkspace')
      return
    }
    const platform = window.cairn?.windowControls?.platform
    const references: { path: string; kind: 'file' | 'dir' }[] = []
    for (const file of files) {
      const relative = relativeMentionPath(root, file.path, platform)
      if (relative === undefined) continue
      references.push({ path: relative, kind: file.kind })
    }
    if (references.length === 0) {
      setDropNotice('input.outsideWorkspace')
      return
    }
    if (references.length < files.length) setDropNotice('input.someOutsideWorkspace')
    const element = textarea.current
    let current = text
    let start = element?.selectionStart ?? current.length
    let end = element?.selectionEnd ?? start
    for (const file of references) {
      const next = insertMention(current, start, end, file.path, file.kind)
      current = next.text
      start = next.caret
      end = next.caret
    }
    setText(current)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start, start)
    })
  }

  /** 创建会话并发出第一轮。`parsed` 来自共享的草稿解析，两边行为一致。 */
  const sendParsed = async (parsed: ParsedPrompt) => {
    const path = projectPath.trim()
    const draft = parsed.draft.trim()
    if (path === '' || draft === '' || busy || model === undefined) return
    setBusy(true)
    // 从这里到第一条消息发出为止，会话已经选中但消息区还是空的：
    // 告诉外层别切走，否则欢迎屏会闪一下空状态。
    onCreatingChange?.(true)
    const sessionId = await createSession(path, titleFromPrompt(draft) || undefined)
    if (sessionId === undefined) {
      setBusy(false)
      onCreatingChange?.(false)
      return
    }
    // 新会话先按模型创建，再切换用户选的模型、Agent 或团队，最后才发出第一轮。
    if (!sameModel(model, defaultModel)) await setSessionModel(sessionId, model)
    // 默认 Agent 由主进程决定，不用再切；其余在第一次运行前应用，复用会话内的切换接口。
    // 团队列表可能还没读回来：按记住的 id 交给主进程校验，选中团队时不再单独设 Agent。
    if (selectedTeamId !== undefined) {
      await setSessionTeam(sessionId, selectedTeamId)
    } else if (selectedAgent !== undefined && selectedAgent.agentId !== BUILTIN_CODER_ID) {
      await setSessionAgent(sessionId, {
        id: selectedAgent.agentId,
        version: selectedAgent.version,
      })
    }
    await sendPrompt(draft, parsed.plan ? 'plan' : 'normal', {
      agents: extractAgents(draft, agentMentions),
      agentNames: agentMentions.map((item) => item.name),
      skills: [...parsed.skills],
    })
    // 这条草稿已经发出去了：清掉，免得下次回到新对话页又出现一遍。
    setText('')
    setPlanMode(false)
    clearComposerDraft(NEW_SESSION_DRAFT_KEY)
    setBusy(false)
    onCreatingChange?.(false)
    onDone()
  }

  const send = async () => {
    // `/goal` 要用会话里的目标，新会话还没创建：提示而不是把命令当普通消息发给模型。
    if (sessionOnlyCommand(text) !== undefined) {
      setSessionOnlyNotice(true)
      return
    }
    setSessionOnlyNotice(false)
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
        {/* 建议提示词：点一下填进输入框，用户可以改写或补充后再发送。 */}
        <div className="mt-7 flex max-w-[680px] flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={busy}
              onClick={() => {
                setText(suggestion)
                requestAnimationFrame(() => {
                  const element = textarea.current
                  element?.focus()
                  element?.setSelectionRange(suggestion.length, suggestion.length)
                })
              }}
              className="rounded-full bg-raise px-3.5 py-1.5 text-note text-muted shadow-hair outline-none transition-colors hover:bg-sunk2 hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[880px] shrink-0 px-5 pb-4 min-[1200px]:px-8">
        {sessionOnlyNotice && (
          <p role="status" className="px-1 pb-2 text-note text-muted">
            {t('composer.command.goal.needsSession')}
          </p>
        )}
        {dropNotice && (
          <p role="status" className="px-1 pb-2 text-note text-muted">
            {t(dropNotice)}
          </p>
        )}
        <WorkspaceGitBar
          projectPath={projectPath === '' ? undefined : projectPath}
          projects={projects}
          onSelectProject={changeProject}
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
              if (
                busy ||
                (!event.dataTransfer.types.includes(FILE_DRAG_TYPE) &&
                  !event.dataTransfer.types.includes('Files'))
              ) {
                return
              }
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
              if (busy) return
              const internal = draggedFile(event)
              if (internal !== undefined) {
                event.preventDefault()
                insertReference(internal.path, internal.kind)
                return
              }
              // 其它拖入（如选中的文字）保持浏览器默认行为。
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              insertExternalFiles(externalDroppedFiles(event, window.cairn?.filePaths?.fromFile))
            }}
            onPaste={(event) => {
              const files = pastedFilePaths(event, window.cairn?.filePaths?.fromFile)
              if (files.length === 0) return
              event.preventDefault()
              insertExternalFiles(files)
            }}
            className={cn(
              'rounded-[16px] border border-hair2 bg-raise px-4 pt-3.5 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60',
              dragging && 'border-accent ring-2 ring-accent/20',
            )}
          >
            {dragging && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[16px] border-2 border-dashed border-accent bg-accent/5 text-note text-accent"
              >
                {t('input.dropFiles')}
              </div>
            )}
            <div className="relative">
              <textarea
                ref={textarea}
                rows={2}
                aria-label={t('input.label')}
                placeholder={planMode ? t('composer.plan.placeholder') : t('new.placeholder')}
                value={text}
                onChange={(e) => {
                  const next = e.target.value
                  setText(next)
                  if (sessionOnlyNotice) setSessionOnlyNotice(false)
                  // 用户可能在空闲加载前就输入 `/`：立即补一次（store 会复用进行中的请求）。
                  if (next.trimStart().startsWith('/')) requestSkills()
                }}
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
              <AgentPicker
                agent={
                  selectedAgent === undefined
                    ? undefined
                    : { id: selectedAgent.agentId, version: selectedAgent.version }
                }
                team={selectedTeam}
                onSelect={(next) => {
                  setSelectedAgentId(next.agentId)
                  setSelectedTeamId(undefined)
                  writeNewSessionAgent(projectPath.trim(), next.agentId)
                }}
                onSelectTeam={(next) => {
                  setSelectedTeamId(next.teamId)
                  setSelectedAgentId(undefined)
                  writeNewSessionTeam(projectPath.trim(), next.teamId)
                }}
                onManage={onOpenSettings === undefined ? undefined : () => onOpenSettings('agents')}
              />
              <PermissionMenu />
              <PlanModeChip on={planMode} onExit={() => setPlanMode(false)} />
              <div className="ml-auto flex min-w-0 items-center gap-1">
                <ModelPicker
                  providers={providers}
                  model={model}
                  fixed={fixedModel !== undefined}
                  disabled={fixedModel !== undefined || !hasModel}
                  open={modelMenuOpen}
                  onOpenChange={setModelMenuOpen}
                  onSelect={(next) => {
                    setSelectedModel(next)
                    writeNewSessionModel(projectPath.trim(), next)
                  }}
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
