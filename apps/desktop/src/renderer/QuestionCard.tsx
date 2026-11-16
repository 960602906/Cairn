/**
 * 用户提问卡片（`ask_user`）：模型需要用户在几个方案中选择，或补充信息时浮在输入框上方显示。
 *
 * - 一次可以带 1～4 个问题；卡片一次只显示一个问题，回答后「下一个」，也可以「上一个」改答案。
 * - 每个问题给出 2～6 个选项，模型推荐的一项带「推荐」标记并高亮，但不预先选中。
 * - 每个问题都可以填写自定义回答；多选时可以同时选选项和填写回答。
 * - 「取消」整张放弃：不给答案，工具结果会告诉模型用户取消了，由模型自行决定下一步。
 * - 只有一个问题时不显示翻页；单选时点选项立即提交。键盘：数字键选择，Enter 提交。
 */
import { Check, ChevronLeft, MessageCircleQuestion, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AskUserAnswer,
  AskUserQuestion,
  AskUserResolution,
  PendingQuestion,
} from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { Button, cn } from './ui/index.js'

const NONE: readonly PendingQuestion[] = []

interface Draft {
  readonly selected: readonly string[]
  readonly custom: string
}

type Drafts = Readonly<Record<string, Draft>>

function initialDrafts(question: PendingQuestion): Drafts {
  return Object.fromEntries(
    question.questions.map((entry) => [entry.id, { selected: [], custom: '' }]),
  )
}

function draftOf(drafts: Drafts, questionId: string): Draft {
  return drafts[questionId] ?? { selected: [], custom: '' }
}

function isAnswered(drafts: Drafts, questions: readonly AskUserQuestion[]): boolean {
  return questions.every((question) => {
    const draft = draftOf(drafts, question.id)
    return draft.selected.length > 0 || draft.custom.trim() !== ''
  })
}

/** 键盘事件是否来自正在打字的输入框。 */
function typing(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
    return target.value !== ''
  return target instanceof HTMLElement && target.isContentEditable
}

function buildAnswers(question: PendingQuestion, drafts: Drafts): AskUserAnswer[] {
  return question.questions.map((entry) => {
    const draft = draftOf(drafts, entry.id)
    const custom = draft.custom.trim()
    return {
      questionId: entry.id,
      selected: [...draft.selected],
      ...(custom === '' ? {} : { custom }),
    }
  })
}

type Resolve = (questionId: string, resolution: AskUserResolution) => Promise<boolean>

/** 一张提问卡片。`onResolve` 用于试运行等复用场景；默认回答当前会话。 */
export function QuestionCard({
  question,
  active,
  onResolve,
}: {
  readonly question: PendingQuestion
  readonly active: boolean
  readonly onResolve?: Resolve | undefined
}) {
  const { t } = useTranslation('session')
  const resolveActive = useSessionStore((s) => s.resolveQuestion)
  const resolve: Resolve = onResolve ?? resolveActive
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(question))
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const total = question.questions.length
  const index = Math.min(step, total - 1)
  const current = question.questions[index]!
  const complete = isAnswered(drafts, question.questions)
  const currentAnswered = isAnswered(drafts, [current])
  const last = index === total - 1

  const submit = async (next: Drafts = drafts) => {
    if (busy || !isAnswered(next, question.questions)) return
    setBusy(true)
    await resolve(question.questionId, { answers: buildAnswers(question, next) })
    setBusy(false)
  }

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    await resolve(question.questionId, { cancelled: true })
    setBusy(false)
  }

  const choose = (target: AskUserQuestion, label: string) => {
    const draft = draftOf(drafts, target.id)
    const multiple = target.multiple === true
    const selected = multiple
      ? draft.selected.includes(label)
        ? draft.selected.filter((value) => value !== label)
        : [...draft.selected, label]
      : [label]
    const next: Drafts = {
      ...drafts,
      [target.id]: {
        selected,
        // 单选时选中选项会清掉自定义回答，避免两个答案同时存在。
        custom: multiple ? draft.custom : '',
      },
    }
    setDrafts(next)
    // 只有一个单选题：点选即提交，少一次点击。
    if (!multiple && total === 1) void submit(next)
  }

  const typeCustom = (target: AskUserQuestion, value: string) => {
    const draft = draftOf(drafts, target.id)
    setDrafts({
      ...drafts,
      [target.id]: {
        // 单选时填写自定义回答会取消选项选择。
        selected: target.multiple === true || value.trim() === '' ? draft.selected : [],
        custom: value,
      },
    })
  }

  /** 「下一个」：回答后前进；已是最后一个问题就提交。 */
  const advance = () => {
    if (busy || !currentAnswered) return
    if (last) void submit()
    else setStep(index + 1)
  }

  const back = () => {
    if (busy || index === 0) return
    setStep(index - 1)
  }

  // 键盘（只在只有一个问题时）：数字键选择，Enter 提交。
  const keys = useRef({ submit, choose, complete, busy })
  keys.current = { submit, choose, complete, busy }
  useEffect(() => {
    if (!active || question.questions.length !== 1) return
    const only = question.questions[0]!
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (document.querySelector('[role="dialog"]:not([aria-hidden="true"]), [role="menu"]')) return
      if (typing(event.target)) return
      const k = keys.current
      if (event.key === 'Enter') {
        if (!k.complete || k.busy) return
        event.preventDefault()
        void k.submit()
        return
      }
      const chosen = Number(event.key) - 1
      if (!Number.isInteger(chosen) || chosen < 0 || chosen >= only.options.length) return
      event.preventDefault()
      void k.choose(only, only.options[chosen]!.label)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, question])

  const recommended = current.options.find((option) => option.recommended === true)
  const multiple = current.multiple === true
  const draft = draftOf(drafts, current.id)

  return (
    <article aria-label={t('question.title')} className="rounded-approval bg-raise p-4 shadow-2">
      <header className="mb-3 flex items-baseline gap-2">
        <MessageCircleQuestion aria-hidden className="size-4 shrink-0 self-center text-accent" />
        <h3 className="text-heading text-fg">{t('question.title')}</h3>
        {total > 1 && (
          <span className="ml-auto shrink-0 text-note text-muted">
            {t('question.number', { index: index + 1, total })}
          </span>
        )}
      </header>
      <section aria-label={t('question.number', { index: index + 1, total })}>
        <div className="mb-2 flex items-start gap-2">
          <p className="min-w-0 flex-1 text-ui text-fg">{current.question}</p>
          {multiple && (
            <span className="shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[11px] text-muted">
              {t('question.multiple')}
            </span>
          )}
        </div>
        <ol aria-label={t('question.options')} className="-mx-1 flex flex-col">
          {current.options.map((option, optionIndex) => {
            const picked = draft.selected.includes(option.label)
            return (
              <li key={option.label}>
                <button
                  type="button"
                  aria-pressed={picked}
                  disabled={busy}
                  onClick={() => choose(current, option.label)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-item px-2.5 py-2 text-left text-ui text-fg transition-colors',
                    picked ? 'bg-accent-soft text-accent' : 'hover:bg-hover',
                    'disabled:opacity-45',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-[6px] font-mono text-[11.5px]',
                      picked ? 'bg-accent text-ink-fg' : 'bg-sunk2 text-fg2',
                    )}
                  >
                    {optionIndex + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>{option.label}</span>
                      {option.recommended === true && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                          <Sparkles aria-hidden className="size-3" />
                          {t('question.recommended')}
                        </span>
                      )}
                    </span>
                    {option.description !== undefined && option.description !== '' && (
                      <span className="mt-0.5 block text-note text-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {picked && <Check aria-hidden className="mt-1 size-3.5 shrink-0" />}
                </button>
              </li>
            )
          })}
        </ol>
        <label className="mt-2 block">
          <span className="mb-1 block text-note text-muted">
            {t('question.custom')}
            {multiple ? ` · ${t('question.customOptional')}` : ''}
          </span>
          <input
            type="text"
            value={draft.custom}
            disabled={busy}
            placeholder={
              recommended
                ? t('question.customPlaceholderRecommended', { option: recommended.label })
                : t('question.customPlaceholder')
            }
            onChange={(event) => typeCustom(current, event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (last) void submit()
              else advance()
            }}
            className="w-full rounded-item bg-sunk px-3 py-2 text-ui text-fg outline-none placeholder:text-faint"
          />
        </label>
      </section>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
          {t('question.cancel')}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {index > 0 && (
            <Button size="sm" disabled={busy} onClick={back}>
              <ChevronLeft aria-hidden />
              {t('question.back')}
            </Button>
          )}
          {last ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !complete}
              onClick={() => void submit()}
            >
              {t('question.submit')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !currentAnswered}
              onClick={advance}
            >
              {t('question.next')}
            </Button>
          )}
        </div>
      </div>
      {!complete && (
        <p className="mt-2 text-note text-muted">
          {last ? t('question.submitHint') : t('question.nextHint')}
        </p>
      )}
    </article>
  )
}

/** 当前会话的待回答提问；没有时不显示。 */
export function QuestionList() {
  const { t } = useTranslation('session')
  const questions = useSessionStore((s) =>
    s.activeSessionId === undefined ? NONE : (s.questions[s.activeSessionId] ?? NONE),
  )
  if (questions.length === 0) return null
  return (
    <section aria-label={t('question.region')} className="flex flex-col gap-3.5">
      {questions.map((question, index) => (
        <QuestionCard key={question.questionId} question={question} active={index === 0} />
      ))}
    </section>
  )
}
