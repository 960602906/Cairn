/**
 * 团队模板版本历史（M7-09 补充）：列出已发布版本，与当前草稿对比，或把旧版本恢复为草稿。
 *
 * 恢复通过 `team.get(teamId, version)` 读取那个版本的完整字段，再作为草稿保存；发布后成为
 * 新版本，不会改写历史。对比只在前端按字段做结构化比较，不额外引入 diff RPC。
 */
import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentTeamVersionSummary, TeamDraftFields } from '@cairn/protocol'
import { agentName } from '../agents/model.js'
import { SettingsGroup } from '../settings/Field.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../ui/index.js'
import {
  teamFieldDiffs,
  teamFieldsOf,
  type TeamFieldDiff,
  type TeamFieldDiffPath,
} from './model.js'

const NONE_VERSIONS: readonly AgentTeamVersionSummary[] = []

export function TeamVersions({
  teamId,
  current,
  readonly = false,
  onRestore,
}: {
  readonly teamId: string
  /** 当前编辑器里的草稿字段；用于和选中的版本对比。 */
  readonly current: TeamDraftFields
  /** 归档的模板只读：仍可查看与对比，但不能恢复为草稿。 */
  readonly readonly?: boolean
  /** 把某个版本恢复为草稿；成功后返回 true。 */
  readonly onRestore: (version: number) => Promise<boolean>
}) {
  const { t, i18n } = useTranslation('teams')
  const teamVersions = useSessionStore((s) => s.teamVersions)
  const getTeam = useSessionStore((s) => s.getTeam)
  const agents = useSessionStore((s) => s.agents)
  const [versions, setVersions] = useState<readonly AgentTeamVersionSummary[] | undefined>(
    undefined,
  )
  const [selected, setSelected] = useState<number | undefined>(undefined)
  const [selectedFields, setSelectedFields] = useState<TeamDraftFields | undefined>(undefined)
  const [confirm, setConfirm] = useState<AgentTeamVersionSummary | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void teamVersions(teamId).then((list) => {
      if (!cancelled) setVersions(list ?? NONE_VERSIONS)
    })
    return () => {
      cancelled = true
    }
  }, [teamId, teamVersions])

  const nameOf = (agentId: string): string => {
    const agent = agents.find((candidate) => candidate.agentId === agentId)
    return agent ? agentName(agent, i18n.language) : agentId
  }

  /** 把对比行的原始值转成可读文本；Agent 与模式用界面语言显示。 */
  const show = (path: TeamFieldDiffPath, value: unknown): string => {
    if (value === undefined || value === '') return t('versions.emptyValue')
    if (path === 'pattern') return t(`pattern.${String(value)}`)
    if (path === 'coordinator') return nameOf(String(value))
    if (path === 'members') {
      const members = value as readonly string[]
      return members.length === 0
        ? t('versions.emptyValue')
        : members.map((member) => nameOf(member)).join('、')
    }
    if (path === 'reviewLoop') {
      const loop = value as { maker: string; checker: string; maxRounds: number }
      return t('versions.reviewValue', {
        maker: nameOf(loop.maker),
        checker: nameOf(loop.checker),
        rounds: loop.maxRounds,
      })
    }
    if (path === 'pipeline') {
      const stages = value as readonly { agent: string; dependsOn?: readonly string[] }[]
      return stages.length === 0
        ? t('versions.emptyValue')
        : stages.map((stage, index) => `${index + 1}. ${nameOf(stage.agent)}`).join('；')
    }
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  const compare = async (version: number) => {
    setNotice(undefined)
    setSelected(version)
    setSelectedFields(undefined)
    const detail = await getTeam(teamId, version)
    const fields = detail ? teamFieldsOf({ published: detail.published }) : undefined
    if (!fields) {
      setSelected(undefined)
      setNotice(t('versions.loadFailed'))
      return
    }
    setSelectedFields(fields)
  }

  const restore = async () => {
    if (confirm === undefined || busy) return
    const version = confirm.version
    setBusy(true)
    const restored = await onRestore(version)
    setBusy(false)
    setConfirm(undefined)
    if (restored) setNotice(t('versions.restored', { version }))
  }

  const rows: readonly TeamFieldDiff[] =
    selected !== undefined && selectedFields !== undefined
      ? teamFieldDiffs(selectedFields, current)
      : []

  return (
    <SettingsGroup
      icon={<History />}
      title={t('versions.title')}
      description={t('versions.description')}
    >
      {versions === undefined ? (
        <p className="text-note text-muted">{t('versions.loading')}</p>
      ) : versions.length === 0 ? (
        <p className="text-note text-muted">{t('versions.empty')}</p>
      ) : (
        <ul aria-label={t('versions.title')} className="flex flex-col gap-1.5">
          {[...versions].reverse().map((version) => {
            const latest = version.version === versions.at(-1)?.version
            return (
              <li
                key={version.version}
                className="flex flex-wrap items-center gap-2 rounded-card bg-raise px-3.5 py-2.5 shadow-hair2"
              >
                <span className="tabular text-ui font-medium text-fg">
                  {t('version', { version: version.version })}
                </span>
                {latest && (
                  <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">
                    {t('versions.current')}
                  </span>
                )}
                <span className="text-note text-muted">
                  {t('versions.meta', {
                    pattern: t(`pattern.${version.pattern}`),
                    count: version.memberCount,
                    date: new Date(version.publishedAt).toLocaleString(i18n.language),
                  })}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void compare(version.version)}>
                    {t('versions.compare')}
                  </Button>
                  {!readonly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirm(version)}
                    >
                      {t('versions.restore')}
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {notice && <p className="text-note text-muted">{notice}</p>}

      {selected !== undefined && selectedFields !== undefined && (
        <div className="flex flex-col gap-2">
          <h4 className="text-note font-medium text-fg2">
            {t('versions.diffTitle', { version: selected })}
          </h4>
          {rows.length === 0 ? (
            <p className="text-note text-muted">{t('versions.noDiff')}</p>
          ) : (
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-note text-muted">
                  <th className="w-1/4 py-1.5 font-normal"> </th>
                  <th className="py-1.5 font-normal">{t('version', { version: selected })}</th>
                  <th className="py-1.5 font-normal">{t('versions.draft')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.path} className="border-t-[0.5px] border-hair align-top">
                    <td className="py-1.5 pr-2 text-fg2">{t(`versions.field.${row.path}`)}</td>
                    <td className="py-1.5 pr-2 break-words text-danger">
                      {show(row.path, row.from)}
                    </td>
                    <td className="py-1.5 break-words text-ok">{show(row.path, row.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Dialog
        open={confirm !== undefined}
        onOpenChange={(next) => {
          if (!next) setConfirm(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {t('versions.restoreTitle', { version: confirm?.version ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('versions.restoreDescription')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('versions.cancel')}</Button>
            </DialogClose>
            <Button variant="primary" disabled={busy} onClick={() => void restore()}>
              {t('versions.restoreConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}
