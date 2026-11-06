/**
 * 撤销本轮（M1-16b，架构 §11.3）：把工作区恢复到最近一轮开始时的检查点（`turn_start`）。
 *
 * - 本轮结束（完成、停止或失败）且会话空闲时显示按钮；
 * - 点击后先预览（`checkpoint.preview`），列出将恢复的文件，确认后才恢复（`checkpoint.restore`）；
 * - 对话记录保留（M1 不截断对话）；恢复前主进程会再建检查点，恢复本身可以撤销（界面在 M2）。
 *
 * 找不到检查点、预览或恢复失败时，错误由错误横幅显示。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckpointFileChange } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'

type Stage =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'confirm'
      readonly checkpointId: string
      readonly files: readonly CheckpointFileChange[]
    }
  | { readonly kind: 'done'; readonly count: number }

export function UndoTurn({
  sessionId,
  turnId,
}: {
  readonly sessionId: string
  readonly turnId: string
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const turnCheckpoint = useSessionStore((s) => s.turnCheckpoint)
  const previewRestore = useSessionStore((s) => s.previewRestore)
  const restoreCheckpoint = useSessionStore((s) => s.restoreCheckpoint)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setBusy(true)
    const checkpointId = await turnCheckpoint(sessionId, turnId)
    const plan =
      checkpointId === undefined ? undefined : await previewRestore(sessionId, checkpointId)
    setBusy(false)
    if (checkpointId !== undefined && plan) {
      setStage({ kind: 'confirm', checkpointId, files: plan.files })
    }
  }

  const confirm = async (checkpointId: string) => {
    setBusy(true)
    const result = await restoreCheckpoint(sessionId, checkpointId)
    setBusy(false)
    setStage(result ? { kind: 'done', count: result.files.length } : { kind: 'idle' })
  }

  if (stage.kind === 'done') {
    return <div aria-live="polite">{t('undo.done', { count: stage.count })}</div>
  }
  if (stage.kind === 'idle') {
    return (
      <button type="button" disabled={busy} onClick={() => void start()}>
        {t('undo.button')}
      </button>
    )
  }
  return (
    <section role="alertdialog" aria-labelledby="undo-title" aria-describedby="undo-description">
      <h3 id="undo-title">{t('undo.title')}</h3>
      <div id="undo-description">{t('undo.description')}</div>
      {stage.files.length === 0 ? (
        <div>{t('undo.noFiles')}</div>
      ) : (
        <ul aria-label={t('undo.files')}>
          {stage.files.map((file) => (
            <li key={file.path}>
              {t(`undo.file.${file.status}`)} <code>{file.path}</code>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={busy || stage.files.length === 0}
        onClick={() => void confirm(stage.checkpointId)}
      >
        {t('undo.confirm')}
      </button>
      <button type="button" disabled={busy} onClick={() => setStage({ kind: 'idle' })}>
        {tc('action.cancel')}
      </button>
    </section>
  )
}
