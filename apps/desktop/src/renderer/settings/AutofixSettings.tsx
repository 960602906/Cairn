/**
 * 设置页“自动修复”：连接 GitHub（M8-01）、查看 PR 的 CI 状态与失败日志，以及管理监视（M8-02）。
 *
 * - 令牌只走 `github.connect`，主进程验证后加密保存，界面没有读取明文的接口；
 * - 仓库 + PR 编号可以直接查询，不需要先打开项目；
 * - 监视列表来自主进程轮询：CI 失败或合并冲突时在独立工作区自动开会话改代码，
 *   当前阶段（M8-02）不会自动提交或推送；变动经 `autofix.changed` 刷新。
 */
import { useEffect, useState } from 'react'
import { CircleAlert, GitPullRequest, KeyRound, Radar, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import type {
  ErrorInfo,
  GithubCheckConclusion,
  GithubCheckRun,
  GithubPullRequest,
  GithubStatus,
  PullRequestWatch,
} from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { Button, Spinner } from '../ui/index.js'
import { Field, SettingsGroup, inputClass } from './Field.js'
import { SettingsHeader } from './SettingsPage.js'

function useErrorText() {
  const { i18n } = useTranslation()
  return (error: ErrorInfo) => translateError(i18n, error)
}

function toneOf(conclusion: GithubCheckConclusion | undefined, status: string): string {
  if (conclusion === 'success') return 'bg-ok-soft text-ok'
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
    return 'bg-danger-soft text-danger'
  }
  if (conclusion === undefined && status !== 'completed') return 'bg-sunk text-fg2'
  return 'bg-sunk2 text-muted'
}

function CheckRow({
  check,
  onLog,
  loading,
}: {
  readonly check: GithubCheckRun
  readonly onLog: () => void
  readonly loading: boolean
}) {
  const { t } = useTranslation('settings')
  const label =
    check.conclusion === undefined
      ? t(`autofix.check.status.${check.status}`, { defaultValue: check.status })
      : t(`autofix.check.conclusion.${check.conclusion}`)
  const failed =
    check.conclusion !== undefined &&
    check.conclusion !== 'success' &&
    check.conclusion !== 'skipped'
  return (
    <li className="flex items-center gap-2.5 px-2.5 py-1.5 [&+&]:shadow-[0_-0.5px_0_var(--hair)]">
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{check.name}</span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${toneOf(check.conclusion, check.status)}`}
      >
        {label}
      </span>
      {failed && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1.5"
          disabled={loading}
          onClick={onLog}
        >
          {loading ? <Spinner /> : null}
          {t('autofix.check.log')}
        </Button>
      )}
    </li>
  )
}

export function AutofixSettings() {
  const { t } = useTranslation('settings')
  const errorText = useErrorText()
  const status = useSessionStore((s) => s.githubStatus)
  const gitHubStatus = useSessionStore((s) => s.githubConnect)
  const disconnect = useSessionStore((s) => s.githubDisconnect)
  const pullRequest = useSessionStore((s) => s.githubPullRequest)
  const checkLog = useSessionStore((s) => s.githubCheckLog)
  const apiError = useSessionStore((s) => s.error)
  const clearError = useSessionStore((s) => s.clearError)
  const autofix = useSessionStore((s) => s.autofix)
  const refreshAutofix = useSessionStore((s) => s.refreshAutofix)
  const addAutoFixWatch = useSessionStore((s) => s.addAutoFixWatch)
  const updateAutoFixWatch = useSessionStore((s) => s.updateAutoFixWatch)
  const removeAutoFixWatch = useSessionStore((s) => s.removeAutoFixWatch)
  const setAutoFixPaused = useSessionStore((s) => s.setAutoFixPaused)
  const projects = useSessionStore((s) => s.projects)

  const [connection, setConnection] = useState<GithubStatus | undefined>(undefined)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const [repo, setRepo] = useState('')
  const [issueNumber, setIssueNumber] = useState('')
  const [pull, setPull] = useState<GithubPullRequest | undefined>(undefined)
  const [querying, setQuerying] = useState(false)
  const [logFor, setLogFor] = useState<number | undefined>(undefined)
  const [log, setLog] = useState<{ text: string; truncated: boolean } | undefined>(undefined)
  const [logLoading, setLogLoading] = useState(false)

  const [watchRepo, setWatchRepo] = useState('')
  const [watchNumber, setWatchNumber] = useState('')
  const [watchPath, setWatchPath] = useState('')
  const [watchBusy, setWatchBusy] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)

  useEffect(() => {
    void status().then((value) => value && setConnection(value))
    void refreshAutofix()
  }, [status, refreshAutofix])

  useEffect(() => {
    if (watchPath === '' && projects.length > 0) setWatchPath(projects[0]!.path)
  }, [projects, watchPath])

  const connected = connection?.connected === true
  const repoValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim())
  const number = Number(issueNumber)
  const numberValid = Number.isInteger(number) && number > 0
  const watchRepoValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(watchRepo.trim())
  const watchNumberValue = Number(watchNumber)
  const watchNumberValid = Number.isInteger(watchNumberValue) && watchNumberValue > 0

  const connect = async () => {
    if (token.trim() === '') return
    clearError()
    setBusy(true)
    const next = await gitHubStatus(token.trim())
    setBusy(false)
    if (next) {
      setConnection(next)
      setToken('')
    }
  }

  const leave = async () => {
    clearError()
    setBusy(true)
    const next = await disconnect()
    setBusy(false)
    if (next) {
      setConnection(next)
      setPull(undefined)
      setLog(undefined)
    }
  }

  const query = async () => {
    clearError()
    setQuerying(true)
    setLog(undefined)
    setLogFor(undefined)
    const next = await pullRequest(repo.trim(), number)
    setQuerying(false)
    if (next) setPull(next)
  }

  const addWatch = async () => {
    if (!watchRepoValid || !watchNumberValid || watchPath === '') return
    clearError()
    setWatchBusy(true)
    const next = await addAutoFixWatch({
      repo: watchRepo.trim(),
      prNumber: watchNumberValue,
      projectPath: watchPath,
    })
    setWatchBusy(false)
    if (next) {
      setWatchRepo('')
      setWatchNumber('')
    }
  }

  const toggleWatch = async (watch: PullRequestWatch) => {
    clearError()
    await updateAutoFixWatch({ watchId: watch.watchId, enabled: !watch.enabled })
  }

  const dropWatch = async (watch: PullRequestWatch) => {
    clearError()
    setWatchBusy(true)
    await removeAutoFixWatch(watch.watchId)
    setWatchBusy(false)
  }

  const watches = autofix?.watches ?? []
  const jobs = autofix?.jobs ?? []

  const togglePause = async () => {
    clearError()
    setPauseBusy(true)
    await setAutoFixPaused(!(autofix?.paused ?? false))
    setPauseBusy(false)
  }

  const openLog = async (forRepo: string, checkId: number) => {
    clearError()
    setLogFor(checkId)
    setLog(undefined)
    setLogLoading(true)
    const next = await checkLog(forRepo, checkId)
    setLogLoading(false)
    if (next) setLog(next)
  }

  return (
    <>
      <SettingsHeader
        icon={<GitPullRequest />}
        title={t('section.autofix.title')}
        description={t('section.autofix.description')}
      />

      <SettingsGroup
        icon={<KeyRound />}
        title={t('autofix.connect.title')}
        description={t('autofix.connect.description')}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-ui text-fg">
            {connected
              ? connection?.login
                ? t('autofix.connect.connectedAs', { login: connection.login })
                : t('autofix.connect.connected')
              : t('autofix.connect.disconnected')}
          </span>
          {connected && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void leave()}>
              {t('autofix.connect.disconnect')}
            </Button>
          )}
        </div>
        {!connected && (
          <Field label={t('autofix.connect.tokenLabel')} hint={t('autofix.connect.tokenHint')}>
            <div className="flex gap-2">
              <input
                type="password"
                aria-label={t('autofix.connect.tokenLabel')}
                className={inputClass}
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void connect()
                }}
              />
              <Button disabled={busy || token.trim() === ''} onClick={() => void connect()}>
                {t('autofix.connect.action')}
              </Button>
            </div>
          </Field>
        )}
        {apiError && (
          <p role="alert" className="text-note text-danger">
            {errorText(apiError)}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup
        icon={<RefreshCw />}
        title={t('autofix.pull.title')}
        description={t('autofix.pull.description')}
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <Field label={t('autofix.pull.repoLabel')}>
            <input
              aria-label={t('autofix.pull.repoLabel')}
              className={inputClass}
              value={repo}
              placeholder={t('autofix.pull.repoPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setRepo(event.target.value)}
            />
          </Field>
          <Field label={t('autofix.pull.numberLabel')}>
            <input
              type="number"
              min={1}
              aria-label={t('autofix.pull.numberLabel')}
              className={inputClass}
              value={issueNumber}
              onChange={(event) => setIssueNumber(event.target.value)}
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={!connected || !repoValid || !numberValid || querying}
            onClick={() => void query()}
          >
            {querying ? <Spinner /> : null}
            {t('autofix.pull.query')}
          </Button>
        </div>

        {pull && (
          <div className="flex flex-col gap-3">
            <div className="min-w-0">
              <a
                href={pull.url}
                target="_blank"
                rel="noreferrer"
                className="text-ui font-medium text-fg hover:text-accent"
              >
                {pull.title}
              </a>
              <p className="mt-0.5 text-note text-muted">
                {t('autofix.pull.branches', { head: pull.headRef, base: pull.baseRef })}
                {' · '}
                {t(`autofix.pull.state.${pull.state}`)}
                {pull.draft ? ` · ${t('autofix.pull.draft')}` : ''}
              </p>
            </div>
            {pull.mergeableState === 'dirty' && (
              <p className="flex items-center gap-1.5 text-note text-danger">
                <CircleAlert className="size-3.5 shrink-0" />
                {t('autofix.pull.conflict')}
              </p>
            )}
            {pull.checks.length === 0 ? (
              <p className="text-note text-muted">{t('autofix.pull.noChecks')}</p>
            ) : (
              <ul
                aria-label={t('autofix.pull.checks')}
                className="rounded-card bg-paper shadow-hair"
              >
                {pull.checks.map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    loading={logLoading && logFor === check.id}
                    onLog={() => void openLog(pull.repo, check.id)}
                  />
                ))}
              </ul>
            )}
            {log && (
              <div className="flex flex-col gap-1">
                <p className="text-note text-muted">
                  {t('autofix.log.title')}
                  {log.truncated ? ` · ${t('autofix.log.truncated')}` : ''}
                </p>
                <pre className="max-h-72 overflow-auto rounded-card bg-sunk p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg2">
                  {log.text}
                </pre>
              </div>
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        icon={<Radar />}
        title={t('autofix.watch.title')}
        description={t('autofix.watch.description')}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-ui text-fg">
            {autofix?.paused ? t('autofix.watch.paused') : t('autofix.watch.watching')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pauseBusy || autofix === undefined}
            onClick={() => void togglePause()}
          >
            {autofix?.paused ? t('autofix.watch.resume') : t('autofix.watch.pause')}
          </Button>
        </div>

        {autofix === undefined ? null : watches.length === 0 ? (
          <p className="text-note text-muted">{t('autofix.watch.empty')}</p>
        ) : (
          <ul aria-label={t('autofix.watch.list')} className="flex flex-col gap-2">
            {watches.map((watch) => {
              const job = jobs.find((item) => item.watchId === watch.watchId)
              return (
                <li
                  key={watch.watchId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card bg-paper px-3 py-2 shadow-hair"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui font-medium text-fg">
                      {watch.repo}#{watch.prNumber}
                    </p>
                    <p className="mt-0.5 truncate text-note text-muted">
                      {watch.triggers.map((trigger) => t(`autofix.trigger.${trigger}`)).join(' · ')}
                      {' · '}
                      {t('autofix.watch.attempts', {
                        attempts: watch.attempts,
                        max: watch.maxAttempts,
                      })}
                      {job === undefined
                        ? ''
                        : ` · ${t('autofix.job.latest', {
                            status: t(`autofix.job.status.${job.status}`),
                          })}`}
                    </p>
                  </div>
                  <span className="truncate text-note text-muted">{watch.projectPath}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={watchBusy}
                    onClick={() => void toggleWatch(watch)}
                  >
                    {watch.enabled ? t('autofix.watch.disable') : t('autofix.watch.enable')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={watchBusy}
                    onClick={() => void dropWatch(watch)}
                  >
                    {t('autofix.watch.remove')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto]">
          <Field label={t('autofix.watch.projectLabel')}>
            <select
              aria-label={t('autofix.watch.projectLabel')}
              className={inputClass}
              value={watchPath}
              onChange={(event) => setWatchPath(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.projectId} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('autofix.watch.repoLabel')}>
            <input
              aria-label={t('autofix.watch.repoLabel')}
              className={inputClass}
              value={watchRepo}
              placeholder={t('autofix.pull.repoPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setWatchRepo(event.target.value)}
            />
          </Field>
          <Field label={t('autofix.watch.numberLabel')}>
            <input
              type="number"
              min={1}
              aria-label={t('autofix.watch.numberLabel')}
              className={inputClass}
              value={watchNumber}
              onChange={(event) => setWatchNumber(event.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              disabled={
                !connected || watchPath === '' || !watchRepoValid || !watchNumberValid || watchBusy
              }
              onClick={() => void addWatch()}
            >
              {watchBusy ? <Spinner /> : null}
              {t('autofix.watch.add')}
            </Button>
          </div>
        </div>
        <p className="text-note text-muted">
          {connected ? t('autofix.watch.worktreeHint') : t('autofix.watch.needConnection')}
        </p>
      </SettingsGroup>
    </>
  )
}
