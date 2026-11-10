/**
 * 设置页“MCP 服务”（M3-10，管理界面 §10.2）：列表、添加 / 编辑、详情、工具权限与连接日志。
 *
 * - 配置里不保存环境变量值与令牌；界面只显示“已设置”，留空表示保持原值。
 * - 保存后立即连接，返回的详情带着当前工具列表；连接状态变化由 `mcp.status` 推动刷新。
 * - 工具默认 `network` / `ask`，用户可以按工具修改类别与默认效果。
 */
import { ChevronRight, Cloud, ListChecks, Plus, TriangleAlert, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  McpAuthKind,
  McpLogEntry,
  McpServerDetail,
  McpServerInput,
  McpServerKind,
  McpServerSummary,
  McpToolSummary,
  PermissionEffect,
  ToolCategory,
} from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  Switch,
} from '../ui/index.js'
import { Field, inputClass, SettingsCard, SettingsEmpty } from './Field.js'
import { ListFilter } from './ListFilter.js'
import { SettingsHeader } from './SettingsPage.js'
import { McpGlyph } from './SettingIcons.js'
import { McpMarketDialog } from './McpMarketDialog.js'

const CATEGORIES: readonly ToolCategory[] = ['read', 'write', 'execute', 'network']
const EFFECTS: readonly PermissionEffect[] = ['allow', 'ask', 'deny']
const AUTH_KINDS: readonly McpAuthKind[] = ['none', 'bearer', 'header']

interface EnvDraft {
  readonly name: string
  readonly value: string
  readonly configured: boolean
}

interface FormState {
  readonly serverId?: string
  readonly name: string
  readonly kind: McpServerKind
  readonly command: string
  readonly args: string
  readonly cwd: string
  readonly env: readonly EnvDraft[]
  readonly url: string
  readonly auth: McpAuthKind
  readonly headerName: string
  readonly token: string
  readonly clearToken: boolean
  readonly tokenConfigured: boolean
  readonly enabled: boolean
}

const emptyForm = (): FormState => ({
  name: '',
  kind: 'stdio',
  command: '',
  args: '',
  cwd: '',
  env: [],
  url: '',
  auth: 'none',
  headerName: '',
  token: '',
  clearToken: false,
  tokenConfigured: false,
  enabled: true,
})

const formOf = (detail: McpServerDetail): FormState => ({
  serverId: detail.serverId,
  name: detail.name,
  kind: detail.kind,
  command: detail.command ?? '',
  args: (detail.args ?? []).join('\n'),
  cwd: detail.cwd ?? '',
  env: detail.env.map((entry) => ({ ...entry, value: '' })),
  url: detail.url ?? '',
  auth: detail.auth,
  headerName: detail.headerName ?? '',
  token: '',
  clearToken: false,
  tokenConfigured: detail.tokenConfigured,
  enabled: detail.enabled,
})

function inputOf(form: FormState): McpServerInput {
  const env = form.env
    .filter((entry) => entry.name.trim() !== '')
    .map((entry) => ({
      name: entry.name.trim(),
      ...(entry.value === '' ? {} : { value: entry.value }),
    }))
  const base = {
    name: form.name.trim(),
    kind: form.kind,
    enabled: form.enabled,
    ...(env.length > 0 ? { env } : {}),
  }
  if (form.kind === 'stdio') {
    const args = form.args
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return {
      ...base,
      command: form.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(form.cwd.trim() === '' ? {} : { cwd: form.cwd.trim() }),
    }
  }
  return {
    ...base,
    url: form.url.trim(),
    auth: form.auth,
    ...(form.auth === 'header' ? { headerName: form.headerName.trim() } : {}),
    ...(form.token === '' ? {} : { token: form.token }),
    ...(form.clearToken ? { clearToken: true } : {}),
  }
}

const statusClass = (status: McpServerSummary['status']) => {
  if (status === 'connected') return 'bg-ok-soft text-ok'
  if (status === 'error') return 'bg-danger-soft text-danger'
  if (status === 'connecting') return 'bg-warn-soft text-warn'
  return 'bg-sunk text-muted'
}

function ServerCard({
  server,
  selectionMode = false,
  selected = false,
  onSelect,
  onOpen,
  onToggle,
}: {
  readonly server: McpServerSummary
  readonly selectionMode?: boolean
  readonly selected?: boolean
  readonly onSelect?: (selected: boolean) => void
  readonly onOpen: (serverId: string) => void
  readonly onToggle: (server: McpServerSummary, enabled: boolean) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <li>
      <SettingsCard
        aria-label={server.name}
        className={cn(
          'cursor-pointer gap-2 px-4 py-3',
          selected && 'shadow-[0_0_0_1.5px_var(--accent)]',
        )}
        onClick={() => (selectionMode ? onSelect?.(!selected) : onOpen(server.serverId))}
      >
        <div className="flex min-w-0 items-center gap-3">
          {selectionMode && (
            <span className="flex" onClick={(event) => event.stopPropagation()}>
              <Checkbox
                checked={selected}
                aria-label={t('mcp.selectAria', { name: server.name })}
                onChange={(event) => onSelect?.(event.currentTarget.checked)}
              />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-[14px] font-medium text-fg">{server.name}</p>
              <span className="shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[11px] text-muted">
                {t(`mcp.kind.${server.kind}`)}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${statusClass(server.status)}`}
              >
                {t(`mcp.status.${server.status}`)}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px]">
              <span className="shrink-0 tabular text-faint">
                {t('mcp.summary', { count: server.toolCount })}
              </span>
              {server.error && (
                <span className="min-w-0 truncate text-danger">
                  {t('mcp.error', { code: server.error.code, message: server.error.message })}
                </span>
              )}
            </div>
          </div>
          {!selectionMode && (
            <div
              className="flex shrink-0 items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              <Switch
                checked={server.enabled}
                aria-label={t('mcp.enabledAria', { name: server.name })}
                title={t('mcp.enabled')}
                onCheckedChange={(enabled) => onToggle(server, enabled)}
              />
              <IconButton
                label={t('mcp.detailAria', { name: server.name })}
                size="icon-sm"
                onClick={() => onOpen(server.serverId)}
              >
                <ChevronRight />
              </IconButton>
            </div>
          )}
        </div>
      </SettingsCard>
    </li>
  )
}

function ToolRow({
  tool,
  onChange,
}: {
  readonly tool: McpToolSummary
  readonly onChange: (patch: { category?: ToolCategory; effect?: PermissionEffect }) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <li className="flex flex-col gap-3 rounded-card bg-raise px-4 py-3 shadow-[0_0_0_0.5px_var(--hair2)]">
      <div className="min-w-0">
        <code className="block truncate font-mono text-[12.5px] text-fg [font-variant-ligatures:none]">
          {tool.name}
        </code>
        {tool.description !== '' && (
          <p className="mt-1 text-[12.5px] text-muted">{tool.description}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-2 whitespace-nowrap text-note text-muted">
          {t('mcp.tool.category')}
          <select
            className={`${inputClass} w-auto`}
            aria-label={t('mcp.tool.categoryAria', { name: tool.name })}
            value={tool.category}
            onChange={(event) => onChange({ category: event.target.value as ToolCategory })}
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`permissions.category.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-note text-muted">
          {t('mcp.tool.effect')}
          <select
            className={`${inputClass} w-auto`}
            aria-label={t('mcp.tool.effectAria', { name: tool.name })}
            value={tool.effect}
            onChange={(event) => onChange({ effect: event.target.value as PermissionEffect })}
          >
            {EFFECTS.map((effect) => (
              <option key={effect} value={effect}>
                {t(`permissions.effect.${effect}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </li>
  )
}

export function McpSettings() {
  const { t, i18n } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const listMcpServers = useSessionStore((s) => s.listMcpServers)
  const getMcpServer = useSessionStore((s) => s.getMcpServer)
  const addMcpServer = useSessionStore((s) => s.addMcpServer)
  const updateMcpServer = useSessionStore((s) => s.updateMcpServer)
  const removeMcpServer = useSessionStore((s) => s.removeMcpServer)
  const reconnectMcpServer = useSessionStore((s) => s.reconnectMcpServer)
  const setMcpServerEnabled = useSessionStore((s) => s.setMcpServerEnabled)
  const setMcpTool = useSessionStore((s) => s.setMcpTool)
  const mcpLogs = useSessionStore((s) => s.mcpLogs)
  const onMcpStatus = useSessionStore((s) => s.onMcpStatus)

  const [servers, setServers] = useState<readonly McpServerSummary[]>([])
  const [form, setForm] = useState<FormState | undefined>()
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<McpServerDetail | undefined>()
  const [logs, setLogs] = useState<readonly McpLogEntry[]>([])
  const [deleting, setDeleting] = useState<readonly McpServerSummary[]>([])
  const [query, setQuery] = useState('')
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [marketOpen, setMarketOpen] = useState(false)

  const normalized = query.trim().toLocaleLowerCase()
  const visible =
    normalized === ''
      ? servers
      : servers.filter((server) =>
          [
            server.name,
            t(`mcp.kind.${server.kind}`),
            t(`mcp.status.${server.status}`),
            t('mcp.summary', { count: server.toolCount }),
            server.error ? `${server.error.code} ${server.error.message}` : '',
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(normalized),
        )
  const selectedServers = visible.filter((server) => selected.includes(server.serverId))
  const allVisibleSelected =
    visible.length > 0 && visible.every((server) => selected.includes(server.serverId))

  const load = useCallback(async () => {
    const result = await listMcpServers()
    if (result) setServers(result)
  }, [listMcpServers])

  const loadDetail = useCallback(
    async (serverId: string) => {
      const [server, entries] = await Promise.all([getMcpServer(serverId), mcpLogs(serverId)])
      if (server) setDetail(server)
      if (entries) setLogs(entries)
    },
    [getMcpServer, mcpLogs],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return onMcpStatus((event) => {
      void load()
      if (detail?.serverId === event.serverId) void loadDetail(event.serverId)
    })
  }, [detail?.serverId, load, loadDetail, onMcpStatus])

  const openDetail = (serverId: string) => {
    setLogs([])
    void loadDetail(serverId)
  }

  const submit = async () => {
    if (!form || saving) return
    setSaving(true)
    const input = inputOf(form)
    const result = form.serverId
      ? await updateMcpServer(form.serverId, input)
      : await addMcpServer(input)
    setSaving(false)
    if (!result) return
    setForm(undefined)
    await load()
    openDetail(result.serverId)
  }

  const toggle = async (server: McpServerSummary, enabled: boolean) => {
    const updated = await setMcpServerEnabled(server.serverId, enabled)
    if (updated) await load()
  }

  const reconnect = async (target: McpServerDetail) => {
    await reconnectMcpServer(target.serverId)
    await load()
    await loadDetail(target.serverId)
  }

  const changeTool = async (
    target: McpServerDetail,
    tool: McpToolSummary,
    patch: { category?: ToolCategory; effect?: PermissionEffect },
  ) => {
    const updated = await setMcpTool({
      serverId: target.serverId,
      name: tool.name,
      ...patch,
    })
    if (!updated) return
    setDetail({
      ...target,
      tools: target.tools.map((item) => (item.name === updated.name ? updated : item)),
    })
  }

  const confirmDelete = async () => {
    if (deleting.length === 0) return
    const targets = deleting
    setDeleting([])
    const removed = await Promise.all(
      targets.map(async (target) => ({
        serverId: target.serverId,
        ok: await removeMcpServer(target.serverId),
      })),
    )
    if (removed.some((target) => target.ok && target.serverId === detail?.serverId)) {
      setDetail(undefined)
    }
    await load()
  }

  const applyBatch = async (enabled: boolean) => {
    if (busy || selectedServers.length === 0) return
    setBusy(true)
    await Promise.all(
      selectedServers.map((server) => setMcpServerEnabled(server.serverId, enabled)),
    )
    setBusy(false)
    setSelected([])
    setBatchMode(false)
    await load()
  }

  const toggleBatch = () => {
    setBatchMode(!batchMode)
    setSelected([])
  }

  const patchForm = (patch: Partial<FormState>) => {
    if (form === undefined) return
    setForm({ ...form, ...patch })
  }

  const patchEnv = (index: number, patch: Partial<EnvDraft>) => {
    if (form === undefined) return
    setForm({
      ...form,
      env: form.env.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    })
  }

  const addEnv = () => {
    if (form === undefined) return
    setForm({ ...form, env: [...form.env, { name: '', value: '', configured: false }] })
  }

  const removeEnv = (index: number) => {
    if (form === undefined) return
    setForm({ ...form, env: form.env.filter((_entry, i) => i !== index) })
  }

  const canSave =
    form !== undefined &&
    form.name.trim() !== '' &&
    (form.kind === 'stdio' ? form.command.trim() !== '' : form.url.trim() !== '') &&
    (form.auth !== 'header' || form.headerName.trim() !== '')

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SettingsHeader
          icon={<McpGlyph />}
          title={t('section.mcp.title')}
          description={t('section.mcp.description')}
        />
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setMarketOpen(true)}>
            <Cloud />
            {t('mcp.market.button')}
          </Button>
          <Button onClick={() => setForm(emptyForm())}>
            <Plus />
            {t('mcp.add')}
          </Button>
        </div>
      </div>

      {servers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <ListFilter
            value={query}
            onChange={(value) => {
              setQuery(value)
              setSelected([])
            }}
            label={t('mcp.search')}
            placeholder={t('mcp.searchPlaceholder')}
          />
          <Button
            variant={batchMode ? 'secondary' : 'ghost'}
            aria-pressed={batchMode}
            onClick={toggleBatch}
          >
            <ListChecks />
            {batchMode ? t('mcp.batch.exit') : t('mcp.batch.toggle')}
          </Button>
        </div>
      )}

      {batchMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-card bg-sunk px-3 py-2">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={selected.length > 0 && !allVisibleSelected}
            aria-label={t('mcp.batch.selectAll')}
            onChange={(event) =>
              setSelected(
                event.currentTarget.checked ? visible.map((server) => server.serverId) : [],
              )
            }
          />
          <span className="text-note text-muted">
            {t('mcp.batch.selected', { count: selected.length })}
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            disabled={selectedServers.length === 0 || busy}
            onClick={() => void applyBatch(true)}
          >
            {t('mcp.batch.enable')}
          </Button>
          <Button
            size="sm"
            disabled={selectedServers.length === 0 || busy}
            onClick={() => void applyBatch(false)}
          >
            {t('mcp.batch.disable')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            disabled={selectedServers.length === 0 || busy}
            onClick={() => setDeleting(selectedServers)}
          >
            {t('mcp.batch.remove')}
          </Button>
        </div>
      )}

      {servers.length === 0 ? (
        <SettingsEmpty
          icon={<McpGlyph />}
          title={t('mcp.emptyTitle')}
          description={t('mcp.empty')}
        />
      ) : visible.length === 0 ? (
        <SettingsCard className="items-center gap-2 py-8 text-center">
          <p className="text-note text-muted">{t('mcp.searchEmpty')}</p>
        </SettingsCard>
      ) : (
        <ul aria-label={t('mcp.list')} className="flex flex-col gap-3">
          {visible.map((server) => (
            <ServerCard
              key={server.serverId}
              server={server}
              selectionMode={batchMode}
              selected={selected.includes(server.serverId)}
              onSelect={(next) =>
                setSelected((current) =>
                  next
                    ? [...current.filter((id) => id !== server.serverId), server.serverId]
                    : current.filter((id) => id !== server.serverId),
                )
              }
              onOpen={openDetail}
              onToggle={(item, enabled) => void toggle(item, enabled)}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={form !== undefined}
        onOpenChange={(open) => {
          if (!open) setForm(undefined)
        }}
      >
        {form && (
          <DialogContent className="w-[min(640px,calc(100vw-32px))]">
            <DialogTitle>
              {form.serverId === undefined ? t('mcp.new.title') : t('mcp.edit.title')}
            </DialogTitle>
            <DialogDescription>{t('mcp.form.description')}</DialogDescription>
            <div className="mt-4 flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
              <Field label={t('mcp.field.name')} labelFor="mcp-name">
                <input
                  id="mcp-name"
                  className={inputClass}
                  value={form.name}
                  onChange={(event) => patchForm({ name: event.target.value })}
                />
              </Field>
              <Field label={t('mcp.field.kind')} labelFor="mcp-kind">
                <select
                  id="mcp-kind"
                  className={inputClass}
                  value={form.kind}
                  onChange={(event) => patchForm({ kind: event.target.value as McpServerKind })}
                >
                  <option value="stdio">{t('mcp.kind.stdio')}</option>
                  <option value="http">{t('mcp.kind.http')}</option>
                </select>
              </Field>

              {form.kind === 'stdio' ? (
                <>
                  <Field label={t('mcp.field.command')} labelFor="mcp-command">
                    <input
                      id="mcp-command"
                      className={inputClass}
                      value={form.command}
                      onChange={(event) => patchForm({ command: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('mcp.field.args')}
                    labelFor="mcp-args"
                    hint={t('mcp.field.args.hint')}
                  >
                    <textarea
                      id="mcp-args"
                      className={`${inputClass} h-20 py-2`}
                      value={form.args}
                      onChange={(event) => patchForm({ args: event.target.value })}
                    />
                  </Field>
                  <Field label={t('mcp.field.cwd')} labelFor="mcp-cwd">
                    <input
                      id="mcp-cwd"
                      className={inputClass}
                      value={form.cwd}
                      onChange={(event) => patchForm({ cwd: event.target.value })}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label={t('mcp.field.url')} labelFor="mcp-url">
                    <input
                      id="mcp-url"
                      className={inputClass}
                      value={form.url}
                      onChange={(event) => patchForm({ url: event.target.value })}
                    />
                  </Field>
                  <Field label={t('mcp.field.auth')} labelFor="mcp-auth">
                    <select
                      id="mcp-auth"
                      className={inputClass}
                      value={form.auth}
                      onChange={(event) => patchForm({ auth: event.target.value as McpAuthKind })}
                    >
                      {AUTH_KINDS.map((auth) => (
                        <option key={auth} value={auth}>
                          {t(`mcp.auth.${auth}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {form.auth === 'header' && (
                    <Field label={t('mcp.field.headerName')} labelFor="mcp-header-name">
                      <input
                        id="mcp-header-name"
                        className={inputClass}
                        value={form.headerName}
                        onChange={(event) => patchForm({ headerName: event.target.value })}
                      />
                    </Field>
                  )}
                  {form.auth !== 'none' && (
                    <>
                      <Field
                        label={t('mcp.field.token')}
                        labelFor="mcp-token"
                        hint={
                          form.tokenConfigured
                            ? t('mcp.field.token.keep')
                            : t('mcp.field.token.hint')
                        }
                      >
                        <input
                          id="mcp-token"
                          type="password"
                          className={inputClass}
                          placeholder={
                            form.tokenConfigured
                              ? t('mcp.field.token.keep')
                              : t('mcp.field.token.placeholder')
                          }
                          value={form.token}
                          onChange={(event) =>
                            patchForm({ token: event.target.value, clearToken: false })
                          }
                        />
                      </Field>
                      {form.tokenConfigured && (
                        <label className="flex items-center justify-end gap-2 text-note text-muted">
                          {t('mcp.field.token.clear')}
                          <Switch
                            checked={form.clearToken}
                            aria-label={t('mcp.field.token.clear')}
                            onCheckedChange={(clearToken) => patchForm({ clearToken, token: '' })}
                          />
                        </label>
                      )}
                    </>
                  )}
                </>
              )}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[13px] text-fg2">{t('mcp.field.env')}</p>
                  <Button variant="ghost" size="sm" onClick={addEnv}>
                    <Plus />
                    {t('mcp.field.env.add')}
                  </Button>
                </div>
                {form.env.length === 0 ? (
                  <p className="text-note text-muted">{t('mcp.field.env.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {form.env.map((entry, index) => (
                      <li key={index} className="flex items-start gap-2">
                        <input
                          className={inputClass}
                          aria-label={t('mcp.field.env.name')}
                          placeholder={t('mcp.field.env.name')}
                          value={entry.name}
                          onChange={(event) => patchEnv(index, { name: event.target.value })}
                        />
                        <input
                          className={inputClass}
                          type="password"
                          aria-label={t('mcp.field.env.valueAria', { name: entry.name })}
                          placeholder={
                            entry.configured
                              ? t('mcp.field.env.configured')
                              : t('mcp.field.env.value')
                          }
                          value={entry.value}
                          onChange={(event) => patchEnv(index, { value: event.target.value })}
                        />
                        <IconButton
                          label={t('mcp.field.env.remove', { name: entry.name })}
                          size="icon-sm"
                          onClick={() => removeEnv(index)}
                        >
                          <Trash2 />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-note text-muted">{t('mcp.field.env.hint')}</p>
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.cancel')}</Button>
              </DialogClose>
              <Button
                size="lg"
                variant="primary"
                disabled={!canSave || saving}
                onClick={() => void submit()}
              >
                {t('mcp.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      <McpMarketDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        onInstalled={(serverId) => {
          void load().then(() => openDetail(serverId))
        }}
      />

      <Dialog
        open={detail !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined)
        }}
      >
        {detail && (
          <DialogContent className="w-[min(760px,calc(100vw-32px))]">
            <DialogTitle>{detail.name}</DialogTitle>
            <DialogDescription>
              {t('mcp.detail.description', {
                kind: t(`mcp.kind.${detail.kind}`),
                status: t(`mcp.status.${detail.status}`),
              })}
            </DialogDescription>
            {detail.error && (
              <p className="mt-2 text-note text-danger">
                {t('mcp.error', { code: detail.error.code, message: detail.error.message })}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void reconnect(detail)}>
                {t('mcp.reconnect')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setForm(formOf(detail))
                  setDetail(undefined)
                }}
              >
                {t('mcp.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger hover:bg-danger-soft hover:text-danger"
                onClick={() => setDeleting([detail])}
              >
                {t('mcp.delete')}
              </Button>
            </div>

            <h3 className="mt-5 mb-2 text-[13px] font-medium text-fg">{t('mcp.tools')}</h3>
            {detail.tools.length === 0 ? (
              <p className="text-note text-muted">{t('mcp.tools.empty')}</p>
            ) : (
              <ul
                aria-label={t('mcp.tools')}
                className="flex max-h-64 flex-col gap-2 overflow-y-auto"
              >
                {detail.tools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    onChange={(patch) => void changeTool(detail, tool, patch)}
                  />
                ))}
              </ul>
            )}

            <h3 className="mt-5 mb-2 text-[13px] font-medium text-fg">{t('mcp.logs')}</h3>
            {logs.length === 0 ? (
              <p className="text-note text-muted">{t('mcp.logs.empty')}</p>
            ) : (
              <ol
                aria-label={t('mcp.logs')}
                className="max-h-48 overflow-y-auto rounded-card bg-paper px-3 py-2 shadow-hair2"
              >
                {logs.map((entry, index) => (
                  <li key={`${entry.ts}-${index}`} className="flex gap-2 py-0.5 text-[12px]">
                    <span className="shrink-0 tabular text-faint">
                      {new Date(entry.ts).toLocaleTimeString(i18n.language)}
                    </span>
                    <span
                      className={
                        entry.level === 'error'
                          ? 'text-danger'
                          : entry.level === 'warn'
                            ? 'text-warn'
                            : 'text-fg2'
                      }
                    >
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.close')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={deleting.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleting([])
        }}
      >
        {deleting.length > 0 && (
          <DialogContent tone="danger" icon={<TriangleAlert />}>
            <DialogTitle>
              {deleting.length === 1 && deleting[0]
                ? t('mcp.delete.title', { name: deleting[0].name })
                : t('mcp.batch.removeTitle', { count: deleting.length })}
            </DialogTitle>
            <DialogDescription>{t('mcp.delete.description')}</DialogDescription>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.cancel')}</Button>
              </DialogClose>
              <Button size="lg" variant="danger" onClick={() => void confirmDelete()}>
                {t('mcp.delete.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
