/**
 * 用户提问卡片（`ask_user`）：模型需要用户在几个方案中选择，或补充信息时显示在对话底部。
 *
 * - 一次可以带 1～4 个问题；每个问题给出 2～6 个选项，模型推荐的一项带「推荐」标记。
 * - 单选且只有一个问题时，点选项立即提交；其余情况选好后点「提交」。
 * - 每个问题都可以填写自定义回答；多选时可以同时选选项和填写回答。
 * - 键盘（只有一个问题时）：数字键选择，Enter 提交；正在别的输入框里打字时不响应。
 */
import { Check, MessageCircleQuestion, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AskUserAnswer, AskUserQuestion, PendingQuestion } from '@cairn/protocol'
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

/** 一张提问卡片。`onResolve` 用于试运行等复用场景；默认回答当前会话。 */
export function QuestionCard({
  question,
  active,
  onResolve,
}: {
  readonly question: PendingQuestion
  readonly active: boolean
  readonly onResolve?:
    ((questionId: string, answers: readonly AskUserAnswer[]) => Promise<boolean>) | undefined
}) {
  const { t } = useTranslation('session')
  const resolveActive = useSessionStore((s) => s.resolveQuestion)
  const resolve = onResolve ?? resolveActive
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(question))
  const [busy, setBusy] = useState(false)
  const complete = isAnswered(drafts, question.questions)

  const submit = async (next: Drafts = drafts) => {
    if (busy || !isAnswered(next, question.questions)) return
    setBusy(true)
    await resolve(question.questionId, buildAnswers(question, next))
    setBusy(false)
  }

  const choose = (target: AskUserQuestion, label: string) => {
    const current = draftOf(drafts, target.id)
    const multiple = target.multiple === true
    const selected = multiple
      ? current.selected.includes(label)
        ? current.selected.filter((value) => value !== label)
        : [...current.selected, label]
      : [label]
    const next: Drafts = {
      ...drafts,
      [target.id]: {
        selected,
        // 单选时选中选项会清掉自定义回答，避免两个答案同时存在。
        custom: multiple ? current.custom : '',
      },
    }
    setDrafts(next)
    // 只有一个单选题：点选即提交，少一次点击。
    if (!multiple && question.questions.length === 1) void submit(next)
  }

  const typeCustom = (target: AskUserQuestion, value: string) => {
    const current = draftOf(drafts, target.id)
    setDrafts({
      ...drafts,
      [target.id]: {
        // 单选时填写自定义回答会取消选项选择。
        selected: target.multiple === true || value.trim() === '' ? current.selected : [],
        custom: value,
      },
    })
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
      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index >= only.options.length) return
      event.preventDefault()
      void k.choose(only, only.options[index]!.label)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, question])

  return (
    <article aria-label={t('question.title')} className="rounded-approval bg-raise p-4 shadow-2">
      <header className="mb-3 flex items-baseline gap-2">
        <MessageCircleQuestion aria-hidden className="size-4 shrink-0 self-center text-accent" />
        <h3 className="text-heading text-fg">{t('question.title')}</h3>
        {question.questions.length > 1 && (
          <span className="ml-auto shrink-0 text-note text-muted">
            {t('question.total', { count: question.questions.length })}
          </span>
        )}
      </header>
      <div className="flex flex-col gap-4">
        {question.questions.map((entry, questionIndex) => {
          const draft = draftOf(drafts, entry.id)
          const multiple = entry.multiple === true
          const recommended = entry.options.find((option) => option.recommended === true)
          return (
            <section
              key={entry.id}
              aria-label={t('question.number', {
                index: questionIndex + 1,
                total: question.questions.length,
              })}
            >
              <div className="mb-2 flex items-start gap-2">
                {question.questions.length > 1 && (
                  <span
                    aria-hidden
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-sunk2 font-mono text-[11.5px] text-fg2"
                  >
                    {questionIndex + 1}
                  </span>
                )}
                <p className="min-w-0 flex-1 text-ui text-fg">{entry.question}</p>
                {multiple && (
                  <span className="shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[11px] text-muted">
                    {t('question.multiple')}
                  </span>
                )}
              </div>
              <ol aria-label={t('question.options')} className="-mx-1 flex flex-col">
                {entry.options.map((option, index) => {
                  const picked = draft.selected.includes(option.label)
                  return (
                    <li key={option.label}>
                      <button
                        type="button"
                        aria-pressed={picked}
                        disabled={busy}
                        onClick={() => choose(entry, option.label)}
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
                          {index + 1}
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
                      ? t('question.customPlaceholderRecommended', {
                          option: recommended.label,
                        })
                      : t('question.customPlaceholder')
                  }
                  onChange={(event) => typeCustom(entry, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    void submit()
                  }}
                  className="w-full rounded-item bg-sunk px-3 py-2 text-ui text-fg outline-none placeholder:text-faint"
                />
              </label>
            </section>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2.5">
        <Button variant="primary" disabled={busy || !complete} onClick={() => void submit()}>
          {t('question.submit')}
        </Button>
        {!complete && <span className="text-note text-muted">{t('question.submitHint')}</span>}
      </div>
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
