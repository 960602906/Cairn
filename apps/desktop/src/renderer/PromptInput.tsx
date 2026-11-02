/**
 * 输入框与停止按钮（M0-15c）。Enter 发送，Shift+Enter 换行；输入法组字时的 Enter 不发送。
 * 运行中不能发送（主进程会报 `run.busy`），此时显示停止按钮。发送时立即清空输入框，失败时恢复。
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'

export interface PromptInputProps {
  /** 当前会话正在运行一轮（或等待审批）。 */
  readonly active: boolean
  /** 运行正在停止。 */
  readonly stopping: boolean
}

export function PromptInput({ active, stopping }: PromptInputProps) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const abort = useSessionStore((s) => s.abort)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const canSend = !active && !sending && text.trim() !== ''

  const send = async () => {
    if (!canSend) return
    const draft = text
    setText('')
    setSending(true)
    const sent = await sendPrompt(draft)
    setSending(false)
    if (!sent) setText((current) => (current === '' ? draft : current))
  }

  const stop = async () => {
    setAborting(true)
    await abort()
    setAborting(false)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <form onSubmit={submit}>
      <textarea
        aria-label={t('input.label')}
        placeholder={t('input.placeholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keyDown}
      />
      <button type="submit" disabled={!canSend}>
        {t('input.send')}
      </button>
      {active && (
        <button type="button" disabled={stopping || aborting} onClick={() => void stop()}>
          {tc('action.stop')}
        </button>
      )}
    </form>
  )
}
