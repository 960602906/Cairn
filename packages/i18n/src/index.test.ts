import { describe, expect, it } from 'vitest'
import {
  createI18n,
  detectLocale,
  isLocale,
  NAMESPACES,
  RESOURCES,
  resolveLocale,
  SUPPORTED_LOCALES,
  translateError,
} from './index.js'

describe('resources', () => {
  it('支持中文与英文（ADR-0013），按命名空间拆分', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US'])
    expect(NAMESPACES).toEqual([
      'common',
      'session',
      'settings',
      'agents',
      'trial',
      'onboarding',
      'errors',
    ])
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(RESOURCES[locale]).sort()).toEqual([...NAMESPACES].sort())
    }
  })

  it('每条文案都是非空字符串', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const ns of NAMESPACES) {
        for (const [key, value] of Object.entries(RESOURCES[locale][ns])) {
          expect(typeof value, `${locale}/${ns}:${key}`).toBe('string')
          expect(value.trim(), `${locale}/${ns}:${key}`).not.toBe('')
        }
      }
    }
  })
})

describe('createI18n', () => {
  it('translates flat dotted keys in each locale', () => {
    const zh = createI18n('zh-CN')
    const en = createI18n('en-US')
    expect(zh.t('action.retry')).toBe('重试')
    expect(en.t('action.retry')).toBe('Retry')
    expect(zh.t('status.waiting_approval', { ns: 'session' })).toBe('等待审批')
    expect(en.t('session:status.idle')).toBe('Idle')
  })

  it('interpolates without HTML escaping', () => {
    const en = createI18n('en-US')
    expect(en.t('turn.limit_reached', { ns: 'session', maxSteps: 50 })).toBe(
      'Reached the limit of 50 steps for this turn. You can continue.',
    )
    expect(en.t('errors:unknown', { code: '<x>' })).toBe('An unknown error occurred (<x>)')
  })

  it('switches language at runtime and keeps instances independent', async () => {
    const a = createI18n('en-US')
    const b = createI18n('en-US')
    await a.changeLanguage('zh-CN')
    expect(a.t('action.ok')).toBe('确定')
    expect(b.t('action.ok')).toBe('OK')
  })

  it('returns the key for missing entries', () => {
    expect(createI18n('zh-CN').t('missing.key')).toBe('missing.key')
  })
})

describe('translateError', () => {
  it('translates error codes with params', () => {
    const zh = createI18n('zh-CN')
    expect(
      translateError(zh, { code: 'storage.schema_too_new', params: { version: 3, supported: 2 } }),
    ).toBe('数据库版本（3）比当前应用支持的版本（2）新，请升级应用')
    expect(translateError(createI18n('en-US'), { code: 'rpc.timeout' })).toBe(
      'The request timed out',
    )
  })

  it('falls back to a generic message that names the code', () => {
    expect(translateError(createI18n('zh-CN'), { code: 'model.not_a_real_code' })).toBe(
      '发生未知错误（model.not_a_real_code）',
    )
    expect(translateError(createI18n('en-US'), { code: 'x.y', params: undefined })).toBe(
      'An unknown error occurred (x.y)',
    )
  })

  it('has a message for every error code defined in the packages', () => {
    // 与各包中的 *ErrorCode 常量保持一致（新增错误码时同步补文案）
    const codes = [
      'run.invalid_transition',
      'run.busy',
      'run.disposed',
      'run.limit_reached',
      'run.internal_error',
      'run.too_many_runs',
      'run.unsupported',
      'tool.not_available',
      'tool.failed',
      'tool.denied',
      'model.unknown_error',
      'model.auth_failed',
      'model.rate_limited',
      'model.server_error',
      'model.context_overflow',
      'model.bad_request',
      'model.network_error',
      'provider.invalid_response',
      'storage.not_found',
      'storage.conflict',
      'storage.seq_conflict',
      'storage.invalid_event',
      'storage.schema_too_new',
      'storage.migration_failed',
      'storage.invalid_record',
      'approval.not_found',
      'approval.cancelled',
      'rpc.timeout',
      'rpc.invalid_params',
      'rpc.invalid_result',
      'rpc.method_not_found',
      'rpc.internal',
      'rpc.protocol_mismatch',
      'rpc.closed',
      'host.start_failed',
      'host.exited',
      'host.unresponsive',
      'host.not_initialized',
      'host.already_initialized',
      'mcp.call_failed',
      'mcp.connect_failed',
      'mcp.invalid',
      'mcp.not_connected',
      'mcp.not_found',
      'mcp.timeout',
      'mcp.tool_not_found',
      'settings.write_failed',
      'settings.invalid_default_model',
      'settings.invalid_auxiliary_model',
      'session.unknown_model',
      'credentials.unavailable',
      'credentials.invalid_ref',
      'credentials.invalid_value',
      'credentials.write_failed',
      'credentials.decrypt_failed',
      'project.invalid_path',
      'project.not_found',
      'project.invalid_name',
      'project.invalid_remote',
      'project.clone_target_exists',
      'project.clone_unavailable',
      'project.git_unavailable',
      'project.clone_failed',
      'project.invalid_branch',
      'project.checkout_failed',
      'project.default_immutable',
      'tool.not_found',
      'tool.invalid_input',
      'tool.execution_failed',
      'path.empty',
      'path.invalid_character',
      'path.malformed',
      'path.drive_relative',
      'path.device',
      'path.outside_workspace',
      'path.root_not_absolute',
      'path.root_not_found',
      'path.broken_link',
      'path.read_only',
      'tool.read_file.not_found',
      'tool.read_file.is_directory',
      'tool.read_file.too_large',
      'tool.read_file.offset_out_of_range',
      'tool.read_file.unreadable',
      'tool.load_skill.not_found',
      'tool.list_dir.not_found',
      'tool.list_dir.not_directory',
      'tool.list_dir.unreadable',
      'tool.search.not_found',
      'tool.search.invalid_pattern',
      'tool.search.unavailable',
      'tool.search.failed',
      'tool.write_file.is_directory',
      'tool.write_file.too_large',
      'tool.write_file.changed_since_preview',
      'tool.write_file.failed',
      'tool.edit_file.not_found',
      'tool.edit_file.is_directory',
      'tool.edit_file.too_large',
      'tool.edit_file.binary',
      'tool.edit_file.unsupported_encoding',
      'tool.edit_file.no_match',
      'tool.edit_file.ambiguous',
      'tool.edit_file.no_change',
      'tool.edit_file.changed_since_preview',
      'tool.edit_file.failed',
      'changes.not_found',
      'changes.already_reverted',
      'changes.conflict',
      'changes.hunk_conflict',
      'changes.blob_missing',
      'changes.content_missing',
      'changes.failed',
      'shell.spawn_failed',
      'sandbox.unavailable',
      'sandbox.setup_failed',
      'sandbox.spawn_failed',
      'sandbox.appcontainer_failed',
      'checkpoint.git_unavailable',
      'checkpoint.not_found',
      'checkpoint.failed',
      'plan.not_pending',
      'plan.unknown_step',
      'plan.no_active_plan',
      'permission.plan_mode',
      'skills.invalid',
      'skills.duplicate',
      'skills.traversal',
      'skills.too_large',
      'skills.not_found',
      'skills.not_uninstallable',
      'agent.not_found',
      'agent.readonly',
      'agent.invalid',
      'agent.in_use',
      'agent.no_draft',
      'update.not_packaged',
      'update.disabled_by_env',
      'update.platform_unsupported',
      'update.source_missing',
      'update.source_insecure',
      'update.channel_invalid',
      'update.publisher_missing',
      'update.check_failed',
      'update.not_found',
      'update.network',
      'update.download_failed',
      'update.verification_failed',
      'update.signature_invalid',
      'update.insufficient_space',
      'update.busy',
      'update.backup_failed',
      'update.install_failed',
      'update.not_downloaded',
      'update.cancelled',
      'update.invalid_manifest',
      'update.version_invalid',
    ]
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(RESOURCES[locale].errors).sort()).toEqual([...codes, 'unknown'].sort())
    }
  })
})

describe('locale detection', () => {
  it.each([
    [['zh-CN'], 'zh-CN'],
    [['zh-Hans-CN', 'en-US'], 'zh-CN'],
    [['zh_TW'], 'zh-CN'],
    [['ZH'], 'zh-CN'],
    [['en-US', 'zh-CN'], 'en-US'],
    [['ja-JP'], 'en-US'],
    [['zhx'], 'en-US'],
    [['', ' zh-CN'], 'zh-CN'],
    [[], 'en-US'],
  ] as const)('%j → %s', (system, expected) => {
    expect(detectLocale(system)).toBe(expected)
  })

  it('prefers a valid saved setting', () => {
    expect(resolveLocale('en-US', ['zh-CN'])).toBe('en-US')
    expect(resolveLocale('fr-FR', ['zh-CN'])).toBe('zh-CN')
    expect(resolveLocale(undefined, ['en-GB'])).toBe('en-US')
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale(1)).toBe(false)
  })
})
