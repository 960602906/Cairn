/**
 * 新对话首页（对齐 LiveAgent）：上方是应用标志与随时段变化的问候，输入框像对话页一样贴在底部，
 * 工作空间与分支显示在输入框上方。发送时先用当前工作空间创建会话，再把这条输入作为第一轮发送。
 *
 * 还没有配置模型供应商时，在输入框下方提示先去设置添加；还没有工作空间时可以打开本地文件夹。
 */
import { ArrowUp, Cpu } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'
import { WorkspaceGitBar } from './WorkspaceGitBar.js'
import { Button, CairnMark } from './ui/index.js'

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
  onSettings,
}: {
  /** 从某个工作空间的“新建会话”进入时预先选中的项目路径。 */
  readonly initialProjectPath?: string | undefined
  /** 会话创建并发出第一条消息后离开新对话页。 */
  readonly onDone: () => void
  /** 打开设置页的“模型供应商”（没有配置供应商时的引导）。 */
  readonly onSettings?: () => void
}) {
  const { t } = useTranslation('session')
  const createSession = useSessionStore((s) => s.createSession)
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const openProject = useSessionStore((s) => s.openProject)
  // 设置还没读到时不提示（旧版主进程或测试替身可能不返回供应商列表）
  const noProvider = useSessionStore((s) => s.settings?.providers?.length === 0)
  const [projectPath, setProjectPath] = useState(initialProjectPath ?? projects[0]?.path ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const period = useGreetingPeriod()

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
    if (path === '' || draft === '' || busy) return
    setBusy(true)
    const sessionId = await createSession(path, titleFromPrompt(draft) || undefined)
    if (sessionId === undefined) {
      setBusy(false)
      return
    }
    await sendPrompt(draft)
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
        {noProvider && (
          <section
            aria-label={t('new.noProvider.title')}
            className="mb-3 flex items-start gap-3 rounded-card bg-sunk px-4 py-3 shadow-hair"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-raise text-fg2 shadow-1 [&_svg]:size-4">
              <Cpu />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-medium text-fg">{t('new.noProvider.title')}</span>
              <span className="mt-0.5 block text-note text-muted">
                {t('new.noProvider.description')}
              </span>
            </span>
            {onSettings && (
              <Button variant="primary" className="shrink-0" onClick={onSettings}>
                {t('new.noProvider.action')}
              </Button>
            )}
          </section>
        )}

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
            placeholder={t('new.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keyDown}
            className="block max-h-[200px] min-h-12 w-full resize-none bg-transparent px-1 text-body text-fg outline-none placeholder:text-faint"
          />
          <div className="mt-2 flex items-center gap-1">
            <button
              type="button"
              aria-label={t('input.send')}
              title={t('input.send')}
              disabled={busy || projectPath.trim() === '' || text.trim() === ''}
              onClick={() => void send()}
              className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg transition-opacity hover:opacity-85 disabled:opacity-25"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
