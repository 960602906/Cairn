/**
 * 诊断包导出弹窗（M3-13）：展示导出前清单、敏感内容开关、导出与在文件夹中显示。
 */
import { Check, Download, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiagnosticsExportResult, DiagnosticsSummary } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Switch,
} from '../ui/index.js'

export interface DiagnosticsExportDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly sessionId?: string | undefined
}

export function DiagnosticsExportDialog({
  open,
  onOpenChange,
  sessionId,
}: DiagnosticsExportDialogProps) {
  const { t } = useTranslation('settings')
  const diagnosticsSummary = useSessionStore((s) => s.diagnosticsSummary)
  const exportDiagnostics = useSessionStore((s) => s.exportDiagnostics)
  const showDiagnosticsInFolder = useSessionStore((s) => s.showDiagnosticsInFolder)

  const [includeContent, setIncludeContent] = useState(false)
  const [summary, setSummary] = useState<DiagnosticsSummary | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<DiagnosticsExportResult | undefined>(undefined)

  useEffect(() => {
    if (!open) {
      setResult(undefined)
      return
    }
    let cancelled = false
    setLoading(true)
    void diagnosticsSummary({
      sessionId,
      includeSensitiveSessionContent: includeContent,
    }).then((res) => {
      if (!cancelled) {
        setSummary(res)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, includeContent, diagnosticsSummary])

  const onExport = async () => {
    setExporting(true)
    const res = await exportDiagnostics({
      sessionId,
      includeSensitiveSessionContent: includeContent,
    })
    setExporting(false)
    if (res && !res.cancelled && res.path) {
      setResult(res)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[540px]">
        <DialogTitle>{t('diagnostics.title')}</DialogTitle>
        <DialogDescription>{t('diagnostics.description')}</DialogDescription>

        {result?.path ? (
          <div className="flex flex-col gap-3 py-3">
            <div className="flex items-center gap-2 text-ui text-ok">
              <Check className="size-4" />
              <span>{t('diagnostics.success')}</span>
            </div>
            <p className="rounded-input bg-sunk px-3 py-2 font-mono text-[12px] text-fg2 break-all">
              {result.path}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => void showDiagnosticsInFolder(result.path!)}
              >
                <FolderOpen />
                {t('diagnostics.showInFolder')}
              </Button>
              <DialogClose asChild>
                <Button variant="primary">{t('action.close', { ns: 'common' })}</Button>
              </DialogClose>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            {loading ? (
              <div className="flex h-32 items-center justify-center text-muted">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2 rounded-card bg-sunk p-3 text-ui">
                  <span className="text-note font-medium text-fg">
                    {t('diagnostics.items.title')}
                  </span>
                  <ul className="flex flex-col gap-1.5 text-note text-fg2">
                    <li className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-accent" />
                      <span>
                        {t('diagnostics.items.system')}:{' '}
                        {t('diagnostics.items.systemValue', {
                          appVersion: summary?.appVersion ?? '',
                          electronVersion: summary?.electronVersion ?? '',
                        })}
                      </span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-accent" />
                      <span>
                        {t('diagnostics.items.settings')}:{' '}
                        {t('diagnostics.items.settingsValue', {
                          providers: summary?.settings.providersCount ?? 0,
                          servers: summary?.settings.mcpServersCount ?? 0,
                        })}
                      </span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-accent" />
                      <span>
                        {t('diagnostics.items.logs')}:{' '}
                        {t('diagnostics.items.logsValue', {
                          main: summary?.logs.mainLogLines ?? 0,
                          host: summary?.logs.hostLogLines ?? 0,
                        })}
                      </span>
                    </li>
                    {summary?.session && (
                      <li className="flex items-center gap-2">
                        <span className="size-1.5 rounded-full bg-accent" />
                        <span>
                          {t('diagnostics.items.session')}:{' '}
                          {t('diagnostics.items.sessionValue', {
                            title: summary.session.title,
                            events: summary.session.eventsCount,
                          })}
                        </span>
                      </li>
                    )}
                  </ul>
                </div>

                {sessionId && (
                  <div className="flex items-center justify-between gap-3 border-t-[0.5px] border-hair pt-3">
                    <div className="flex flex-col">
                      <span className="text-[13px] text-fg">{t('diagnostics.includeContent')}</span>
                      <span className="text-note text-muted">
                        {t('diagnostics.includeContentHint')}
                      </span>
                    </div>
                    <Switch
                      checked={includeContent}
                      onCheckedChange={setIncludeContent}
                      aria-label={t('diagnostics.includeContent')}
                    />
                  </div>
                )}
              </>
            )}

            <DialogFooter className="mt-2">
              <DialogClose asChild>
                <Button variant="ghost">{t('action.cancel', { ns: 'common' })}</Button>
              </DialogClose>
              <Button
                variant="primary"
                disabled={loading || exporting}
                onClick={() => void onExport()}
              >
                {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download />}
                {t('diagnostics.export')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
