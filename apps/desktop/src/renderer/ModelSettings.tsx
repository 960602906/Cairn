/**
 * 模型与 Key 的最小设置（M1-16a；完整设置页在 M2）：
 *
 * - 列出已配置的提供方与 Key 状态，可以保存（替换）Key、删除提供方；
 * - 用模板（`PROVIDER_TEMPLATES`）添加提供方，可改接口地址（代理），需要 Key 的模板同时保存 Key；
 * - 选择默认模型（新会话使用）。
 *
 * Key 只经 `credentials.set` 写入，界面读不到明文；系统加密不可用时（Linux 没有密钥环）提示无法保存。
 * 添加的提供方 id 用模板 id，已存在时加序号。
 */
import { PROVIDER_TEMPLATES, findTemplate, providerFromTemplate } from '@nexus/core'
import type { ModelRef, ProviderConfig } from '@nexus/protocol'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'

type KeyStatus = { readonly configured: boolean; readonly available: boolean }

const refKey = (ref: ModelRef) => `${ref.providerId}\u0000${ref.modelId}`

/** 模板 id 已被占用时加序号：`deepseek`、`deepseek-2`…… */
export function uniqueProviderId(base: string, providers: readonly ProviderConfig[]): string {
  const taken = new Set(providers.map((p) => p.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

function ProviderRow({
  provider,
  status,
  onSaveKey,
  onRemove,
}: {
  readonly provider: ProviderConfig
  readonly status: KeyStatus | undefined
  readonly onSaveKey: (secret: string) => Promise<boolean>
  readonly onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const [secret, setSecret] = useState('')
  const name = provider.displayName
  const ref = provider.credentialRef
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (secret.trim() === '') return
    if (await onSaveKey(secret.trim())) setSecret('')
  }
  return (
    <li>
      <strong>{name}</strong> <span>{provider.baseUrl}</span>{' '}
      <span>{t('models.modelCount', { count: provider.models.length })}</span>{' '}
      <span>
        {ref === undefined
          ? t('models.key.notRequired')
          : status?.configured
            ? t('models.key.configured')
            : t('models.key.missing')}
      </span>
      {ref !== undefined && status?.available !== false && (
        <form onSubmit={(e) => void submit(e)}>
          <label>
            {t('models.key.label', { name })}
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button type="submit" disabled={secret.trim() === ''}>
            {t('models.key.save')}
          </button>
        </form>
      )}
      <button type="button" onClick={onRemove}>
        {t('models.remove', { name })}
      </button>
    </li>
  )
}

function AddProviderForm({
  providers,
  keysAvailable,
  onAdd,
}: {
  readonly providers: readonly ProviderConfig[]
  readonly keysAvailable: boolean
  readonly onAdd: (provider: ProviderConfig, secret: string | undefined) => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const [templateId, setTemplateId] = useState(PROVIDER_TEMPLATES[0]!.id)
  const template = findTemplate(templateId)!
  const [baseUrl, setBaseUrl] = useState(template.baseUrl)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const needsKey = template.requiresKey && keysAvailable

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || baseUrl.trim() === '') return
    setBusy(true)
    const provider = providerFromTemplate(template, {
      id: uniqueProviderId(template.id, providers),
      baseUrl: baseUrl.trim(),
    })
    await onAdd(provider, needsKey && secret.trim() !== '' ? secret.trim() : undefined)
    setSecret('')
    setBusy(false)
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby="add-provider-title">
      <h4 id="add-provider-title">{t('models.add.title')}</h4>
      <label>
        {t('models.add.template')}
        <select
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value)
            setBaseUrl(findTemplate(e.target.value)!.baseUrl)
          }}
        >
          {PROVIDER_TEMPLATES.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('models.add.baseUrl')}
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
      </label>
      {needsKey && (
        <label>
          {t('models.add.key')}
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}
      <button type="submit" disabled={busy || baseUrl.trim() === ''}>
        {t('models.add.submit')}
      </button>
    </form>
  )
}

function ModelSettingsPanel() {
  const { t } = useTranslation('settings')
  const settings = useSessionStore((s) => s.settings)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const saveCredential = useSessionStore((s) => s.saveCredential)
  const credentialStatus = useSessionStore((s) => s.credentialStatus)
  const [statuses, setStatuses] = useState<Readonly<Record<string, KeyStatus>>>({})
  const providers = settings?.providers ?? []

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // 每个需要 Key 的提供方查询一次状态
  const refs = providers.flatMap((p) => (p.credentialRef === undefined ? [] : [p.credentialRef]))
  const refList = refs.join('\u0000')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, KeyStatus> = {}
      for (const ref of refList === '' ? [] : refList.split('\u0000')) {
        const status = await credentialStatus(ref)
        if (status) next[ref] = status
      }
      if (!cancelled) setStatuses(next)
    })()
    return () => {
      cancelled = true
    }
  }, [refList, credentialStatus])

  const refreshStatus = async (ref: string) => {
    const status = await credentialStatus(ref)
    if (status) setStatuses((s) => ({ ...s, [ref]: status }))
  }

  const saveKey = async (ref: string, secret: string) => {
    const saved = await saveCredential(ref, secret)
    if (saved) await refreshStatus(ref)
    return saved
  }

  // 没有任何状态时（尚未查询或没有需要 Key 的提供方）假定可用，保存失败时会显示错误
  const keysAvailable = Object.values(statuses).every((s) => s.available)

  const add = async (provider: ProviderConfig, secret: string | undefined) => {
    const first = provider.models[0]
    const next = await updateSettings({
      providers: [...providers, provider],
      ...(settings?.defaultModel === undefined && first
        ? { defaultModel: { providerId: provider.id, modelId: first.id } }
        : {}),
    })
    if (next && secret !== undefined && provider.credentialRef !== undefined) {
      await saveKey(provider.credentialRef, secret)
    }
  }

  const remove = (providerId: string) =>
    void updateSettings({ providers: providers.filter((p) => p.id !== providerId) })

  const models = providers.flatMap((p) =>
    p.models.map((m) => ({
      ref: { providerId: p.id, modelId: m.id },
      label: `${p.displayName} / ${m.displayName ?? m.id}`,
    })),
  )
  const current = settings?.defaultModel
  const currentKey = current ? refKey(current) : ''

  return (
    <section role="dialog" aria-labelledby="model-settings-title">
      <h3 id="model-settings-title">{t('models.title')}</h3>
      {!keysAvailable && <p>{t('models.key.unavailable')}</p>}
      {providers.length === 0 ? (
        <p>{t('models.empty')}</p>
      ) : (
        <ul aria-label={t('models.providers')}>
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              status={p.credentialRef === undefined ? undefined : statuses[p.credentialRef]}
              onSaveKey={(secret) => saveKey(p.credentialRef!, secret)}
              onRemove={() => remove(p.id)}
            />
          ))}
        </ul>
      )}
      <label>
        {t('models.default.label')}
        <select
          value={currentKey}
          onChange={(e) => {
            const picked = models.find((m) => refKey(m.ref) === e.target.value)
            void updateSettings({ defaultModel: picked ? picked.ref : null })
          }}
        >
          <option value="">{t('models.default.none')}</option>
          {models.map((m) => (
            <option key={refKey(m.ref)} value={refKey(m.ref)}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <AddProviderForm providers={providers} keysAvailable={keysAvailable} onAdd={add} />
    </section>
  )
}

export function ModelSettings() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t('models.open')}
      </button>
      {open && <ModelSettingsPanel />}
    </div>
  )
}
