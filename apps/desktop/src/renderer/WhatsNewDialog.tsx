/**
 * 安装重启后的“更新内容”弹窗（M5-07）：
 *
 * - 安装前更新服务把目标版本写入设置 `updateInstalledVersion`；
 * - 启动后若它与 `appInfo.version` 一致，说明刚完成安装，展示构建时嵌入 CHANGELOG 的
 *   `appInfo.releaseNotes`；
 * - 关闭（或点击遮罩 / Esc）后清除标记，之后启动不再弹出；
 * - 版本不一致（安装被取消或失败）时静默清除，避免误弹。
 */
import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Markdown } from './Markdown.js'
import { useSessionStore } from './store-context.js'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/index.js'

export function WhatsNewDialog() {
  const { t } = useTranslation('settings')
  const appInfo = useSessionStore((s) => s.appInfo)
  const settings = useSessionStore((s) => s.settings)
  const loadAppInfo = useSessionStore((s) => s.loadAppInfo)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!appInfo) void loadAppInfo()
  }, [appInfo, loadAppInfo])

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [loadSettings, settings])

  const installedVersion = settings?.updateInstalledVersion
  useEffect(() => {
    if (!appInfo || installedVersion === undefined) return
    if (installedVersion !== appInfo.version) {
      // 安装被取消或失败：标记与当前版本不符，直接清掉。
      void updateSettings({ updateInstalledVersion: null })
      return
    }
    setOpen(true)
  }, [appInfo, installedVersion, updateSettings])

  if (!appInfo) return null
  const notes = appInfo.releaseNotes?.trim()
  const close = () => {
    setOpen(false)
    void updateSettings({ updateInstalledVersion: null })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent icon={<Sparkles />} className="w-[min(600px,calc(100vw-32px))]">
        <DialogTitle>{t('whatsNew.title', { version: appInfo.version })}</DialogTitle>
        <DialogDescription>{t('whatsNew.description')}</DialogDescription>
        <div className="mt-4 max-h-[55vh] overflow-y-auto rounded-[10px] bg-sunk/60 px-4 py-3 text-[13.5px] leading-relaxed">
          {notes ? <Markdown text={notes} /> : <p className="text-fg2">{t('whatsNew.empty')}</p>}
        </div>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" onClick={close}>
            {t('whatsNew.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
