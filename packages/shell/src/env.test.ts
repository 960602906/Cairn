import { describe, expect, it } from 'vitest'
import { isSensitiveEnvName, sanitizeEnv } from './env.js'

describe('sanitizeEnv', () => {
  it('去掉密钥与应用内部变量，其余原样保留', () => {
    const env = sanitizeEnv({
      PATH: '/bin',
      Path: 'C:\\Windows',
      HOME: '/home/u',
      LANG: 'zh_CN.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent',
      TOKENIZERS_PARALLELISM: 'false',
      KEYBOARD: 'us',
      OPENAI_API_KEY: 'x',
      anthropic_api_key: 'x',
      GEMINI_APIKEY: 'x',
      AWS_ACCESS_KEY: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      GITHUB_TOKEN: 'x',
      DB_PASSWORD: 'x',
      PASSWD: 'x',
      GPG_PASSPHRASE: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: 'x',
      CLIENT_SECRET_ID: 'x',
      CAIRN_MODEL_API_KEY: 'x',
      CAIRN_RUNTIME: 'pi',
      Cairn_Host_Trace_File: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      UNDEFINED: undefined,
    })
    expect(env).toEqual({
      PATH: '/bin',
      Path: 'C:\\Windows',
      HOME: '/home/u',
      LANG: 'zh_CN.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent',
      TOKENIZERS_PARALLELISM: 'false',
      KEYBOARD: 'us',
      PYTHONUTF8: '1',
    })
  })

  it('PYTHONUTF8 总是 1（替换任何大小写的已有值）；可另外去掉指定变量', () => {
    expect(sanitizeEnv({ pythonutf8: '0', A: '1', b: '2' }, { remove: ['a', 'B'] })).toEqual({
      PYTHONUTF8: '1',
    })
  })

  it('isSensitiveEnvName', () => {
    expect(isSensitiveEnvName('DEEPSEEK_API_KEY')).toBe(true)
    expect(isSensitiveEnvName('CAIRN_SHELL_COMMAND')).toBe(true)
    expect(isSensitiveEnvName('ELECTRON_RUN_AS_NODE_X')).toBe(false)
    expect(isSensitiveEnvName('MONKEY')).toBe(false)
    expect(isSensitiveEnvName('PATH')).toBe(false)
  })
})
