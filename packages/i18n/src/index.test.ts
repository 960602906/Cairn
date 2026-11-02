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
    expect(NAMESPACES).toEqual(['common', 'session', 'errors'])
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
    expect(translateError(createI18n('zh-CN'), { code: 'model.rate_limited' })).toBe(
      '发生未知错误（model.rate_limited）',
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
      'storage.not_found',
      'storage.conflict',
      'storage.seq_conflict',
      'storage.invalid_event',
      'storage.schema_too_new',
      'storage.migration_failed',
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
      'settings.write_failed',
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
