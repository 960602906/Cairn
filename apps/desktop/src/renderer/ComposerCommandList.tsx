/**
 * `/` 指令面板的列表部分：会话输入框与新对话页共用（对齐两者的输入体验）。
 * 只负责渲染，键盘与执行逻辑在调用方。
 */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { AvailableComposerCommand } from './composer-shared.js'
import { cn } from './ui/index.js'

/** 列表与选项的 id；`aria-controls` / `aria-activedescendant` 共用。 */
export const COMMAND_LIST_ID = 'composer-command-list'
export const commandOptionId = (command: { readonly id: string }) =>
  `composer-command-${command.id}`

export interface ComposerCommandListProps {
  readonly commands: readonly AvailableComposerCommand[]
  readonly activeIndex: number
  readonly onSelect: (command: AvailableComposerCommand) => void
  readonly onHover: (index: number) => void
}

export function ComposerCommandList({
  commands,
  activeIndex,
  onSelect,
  onHover,
}: ComposerCommandListProps) {
  const { t } = useTranslation('session')
  return (
    <div
      id={COMMAND_LIST_ID}
      role="listbox"
      aria-label={t('composer.command.label')}
      className="absolute inset-x-0 bottom-full z-50 mb-2 max-h-64 overflow-y-auto rounded-card bg-raise p-1 text-ui text-fg shadow-2"
    >
      {commands.length === 0 ? (
        <p className="px-2 py-2 text-note text-muted">{t('composer.command.empty')}</p>
      ) : (
        commands.map((command, index) => {
          const selected = index === activeIndex
          const groupStart = index === 0 || commands[index - 1]?.kind !== command.kind
          return (
            <Fragment key={command.id}>
              {groupStart && (
                <p className="px-2 pt-2 pb-1 text-[11px] text-faint">
                  {t(
                    command.kind === 'skill'
                      ? 'composer.command.group.skills'
                      : 'composer.command.group.commands',
                  )}
                </p>
              )}
              <div
                id={commandOptionId(command)}
                role="option"
                aria-selected={selected}
                aria-disabled={command.unavailable !== undefined}
                onMouseDown={(event) => {
                  event.preventDefault()
                  onSelect(command)
                }}
                onMouseEnter={() => onHover(index)}
                className={cn(
                  'flex cursor-default select-none items-start gap-2 rounded-[7px] px-2 py-1.5',
                  selected && 'bg-hover',
                )}
              >
                <span
                  className={cn(
                    'shrink-0 font-mono text-note',
                    command.unavailable === undefined ? 'text-fg' : 'text-faint',
                  )}
                >
                  {'/'}
                  {command.name}
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
                  {command.unavailable === undefined ? command.description : t(command.unavailable)}
                </span>
              </div>
            </Fragment>
          )
        })
      )}
      <p className="mt-1 border-t border-hair px-2 pt-1.5 text-[11px] text-faint">
        {t('composer.command.hint')}
      </p>
    </div>
  )
}
