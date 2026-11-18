/**
 * `/help` 的帮助对话框：列出全部内置指令与常用快捷键。
 *
 * 指令来自输入框实际可用的列表（`AvailableComposerCommand`），与 `/` 面板保持一致；
 * 技能不在这里重复列出，它们本身就以 `/技能名` 出现在面板里。
 */
import { Keyboard } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AvailableComposerCommand } from './composer-shared.js'
import {
  agentPickerShortcut,
  newChatShortcut,
  planShortcut,
  searchShortcut,
  settingsShortcut,
} from './layout/shortcuts.js'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Kbd,
  cn,
} from './ui/index.js'

export function CommandHelpDialog({
  open,
  onOpenChange,
  commands,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** 与 `/` 面板同一份列表；只显示内置指令。 */
  readonly commands: readonly AvailableComposerCommand[]
}) {
  const { t } = useTranslation('session')
  const shortcuts = [
    { label: t('composer.help.shortcut.newChat'), keys: newChatShortcut() },
    { label: t('composer.help.shortcut.search'), keys: searchShortcut() },
    { label: t('composer.help.shortcut.settings'), keys: settingsShortcut() },
    { label: t('composer.help.shortcut.agent'), keys: agentPickerShortcut() },
    { label: t('composer.help.shortcut.plan'), keys: planShortcut() },
    { label: t('composer.help.shortcut.send'), keys: 'Enter' },
    { label: t('composer.help.shortcut.newline'), keys: 'Shift Enter' },
    { label: t('composer.help.shortcut.stop'), keys: 'Esc' },
  ]
  const builtins = commands.filter((command) => command.kind === 'command')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        icon={<Keyboard />}
        className="flex max-h-[min(720px,calc(100vh-48px))] w-[min(720px,calc(100vw-32px))] flex-col"
      >
        <DialogTitle>{t('composer.help.title')}</DialogTitle>
        <DialogDescription>{t('composer.help.description')}</DialogDescription>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <section aria-label={t('composer.help.commands')}>
            <h3 className="text-note font-medium text-fg2">{t('composer.help.commands')}</h3>
            <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {builtins.map((command) => (
                <li key={command.id} className="flex min-w-0 items-baseline gap-2 py-0.5">
                  <span
                    className={cn(
                      'shrink-0 font-mono text-note',
                      command.unavailable === undefined ? 'text-fg' : 'text-faint',
                    )}
                  >
                    /{command.name}
                    {command.args !== 'none' && (
                      <span className="text-faint">
                        {' '}
                        {t(`composer.command.args.${command.args}`)}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 text-note',
                      command.unavailable === undefined ? 'text-muted' : 'text-faint',
                    )}
                  >
                    {command.unavailable === undefined
                      ? command.description
                      : t(command.unavailable)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label={t('composer.help.shortcuts')} className="mt-5">
            <h3 className="text-note font-medium text-fg2">{t('composer.help.shortcuts')}</h3>
            <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label}
                  className="flex items-baseline justify-between gap-2 py-0.5"
                >
                  <dt className="min-w-0 text-note text-muted">{shortcut.label}</dt>
                  <dd className="shrink-0">
                    <Kbd>{shortcut.keys}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('composer.help.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
