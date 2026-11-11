/**
 * 新对话首页（对齐 LiveAgent）：上方是应用标志与随时段变化的问候，输入框像对话页一样贴在底部，
 * 工作空间与分支显示在输入框上方。发送时先用当前工作空间创建会话，再把这条输入作为第一轮发送。
 * 还没有工作空间时可以打开本地文件夹。
 */
import { ArrowUp, ListChecks } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelRef } from '@cairn/protocol'
import {
  enabledModelChoices,
  ModelPicker,
  PermissionMenu,
  resolveDefaultModel,
  sameModel,
} from './Composer.js'
import { planShortcut } from './layout/shortcuts.js'
import { useSessionStore } from './store-context.js'
import { WorkspaceGitBar } from './WorkspaceGitBar.js'
import { CairnMark } from './ui/index.js'

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
  const { t } = useTranslation('session')
  const createSession = useSessionStore((s) => s.createSession)
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const projects = useSessionStore((s) => s.projects)
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
  const textarea = useRef<HTMLTextAreaElement>(null)
  const period = useGreetingPeriod()
  const model = selectedModel ?? resolveDefaultModel(providers, defaultModel)

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    textarea.current?.focus()
  }, [])

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

  const chooseFolder = async () => {
    const project = await openProject()
    if (project) setProjectPath(project.path)
  }

  const send = async () => {
    const path = projectPath.trim()
    const draft = text.trim()
    if (path === '' || draft === '' || busy || model === undefined) return
    setBusy(true)
    const sessionId = await createSession(path, titleFromPrompt(draft) || undefined)
    if (sessionId === undefined) {
      setBusy(false)
      return
    }
    // 新会话先按模型创建，再切换用户选的模型，最后才发出第一轮。
    if (!sameModel(model, defaultModel)) await setSessionModel(sessionId, model)
    await sendPrompt(draft, planMode ? 'plan' : 'normal')
    setBusy(false)
    onDone()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
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
        <div className="rounded-[16px] border border-hair2 bg-raise px-4 pt-3.5 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60">
          <textarea
            ref={textarea}
            rows={2}
            aria-label={t('input.label')}
            placeholder={planMode ? t('composer.plan.placeholder') : t('new.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keyDown}
            className="block max-h-[200px] min-h-12 w-full resize-none bg-transparent px-1 text-body text-fg outline-none placeholder:text-faint"
          />
          <div className="mt-2 flex items-center gap-1">
            <PermissionMenu />
            <button
              type="button"
              aria-pressed={planMode}
              aria-label={t('composer.plan.label')}
              title={t('composer.plan.hint', { shortcut: planShortcut() })}
              onClick={() => setPlanMode((on) => !on)}
              className="flex h-7 items-center gap-1 rounded-item px-2 text-ui text-muted outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent aria-pressed:bg-accent-soft aria-pressed:text-accent"
            >
              <ListChecks className="size-3.5" />
              {t('composer.plan.toggle')}
            </button>
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
                onClick={() => void send()}
                className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-25"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
