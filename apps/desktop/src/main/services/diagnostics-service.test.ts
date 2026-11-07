import { unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  DiagnosticsService,
  redactSecrets,
  sanitizeText,
  summarizeSessionEvents,
  summarizeSettings,
} from './diagnostics-service.js'

describe('diagnostics sanitization', () => {
  it('redacts user home directory in backslash and forwardslash forms', () => {
    const home = 'C:\\Users\\alice'
    const text = 'Log from C:\\Users\\alice\\Desktop\\project and C:/Users/alice/file.txt'
    const result = sanitizeText(text, home)
    expect(result).not.toContain('C:\\Users\\alice')
    expect(result).not.toContain('C:/Users/alice')
    expect(result).toContain('~\\Desktop\\project and ~/file.txt')
  })

  it('redacts OpenAI, GitHub, Slack tokens and Bearer credentials', () => {
    const text = [
      'apiKey: "sk-1234567890abcdef1234567890"',
      'token: "ghp_123456789012345678901234567890"',
      'Authorization: Bearer mySecretToken123',
      'slack: xoxb-123456-abcdef',
    ].join('\n')
    const result = sanitizeText(text, 'C:\\Users\\alice')
    expect(result).not.toContain('sk-1234567890abcdef1234567890')
    expect(result).not.toContain('ghp_123456789012345678901234567890')
    expect(result).not.toContain('mySecretToken123')
    expect(result).not.toContain('xoxb-123456-abcdef')
    expect(result).toContain('[REDACTED')
  })

  it('summarizes settings without any credentials', () => {
    const rawSettings = {
      defaultModel: { providerId: 'p1', modelId: 'm1' },
      providers: [
        {
          id: 'p1',
          displayName: 'Provider 1',
          apiKey: 'sk-secret-key-1234567890',
          baseUrl: 'https://api.openai.com/v1',
          models: [{ id: 'm1', displayName: 'Model 1' }],
        },
      ],
    }
    const mcpServers = [
      {
        serverId: 'srv1',
        name: 'Server 1',
        transport: 'stdio',
        enabled: true,
        env: { SECRET: 'secret_value' },
        bearerToken: 'token123',
      },
    ]

    const summary = summarizeSettings(rawSettings, mcpServers) as {
      providers: { isOfficialUrl: boolean }[]
    }
    expect(JSON.stringify(summary)).not.toContain('sk-secret')
    expect(JSON.stringify(summary)).not.toContain('secret_value')
    expect(JSON.stringify(summary)).not.toContain('token123')
    expect(summary.providers[0]?.isOfficialUrl).toBe(true)
  })

  it('summarizes session events omitting sensitive text by default', () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: 'message.created',
        message: { role: 'user', content: 'Secret project details in C:\\Users\\alice\\app' },
      },
      {
        seq: 2,
        ts: 2000,
        type: 'tool.executed',
        name: 'exec',
        status: 'ok',
        input: { command: 'cat /secret.txt' },
      },
    ]

    const clean = summarizeSessionEvents(events, false, 'C:\\Users\\alice')
    expect(JSON.stringify(clean)).not.toContain('Secret project details')
    expect(JSON.stringify(clean)).not.toContain('cat /secret.txt')
    expect(clean[0]?.type).toBe('message.created')

    const full = summarizeSessionEvents(events, true, 'C:\\Users\\alice')
    expect(JSON.stringify(full)).not.toContain('C:\\Users\\alice')
    expect(JSON.stringify(full)).toContain('~\\\\app')
  })
})

describe('DiagnosticsService zip generation and export', () => {
  const fakeDeps = {
    getAppVersion: () => '1.2.3',
    getElectronVersion: () => '30.0.0',
    getSettings: async () => ({
      providers: [
        {
          id: 'p1',
          displayName: 'P1',
          apiKey: 'sk-98765432101234567890',
          baseUrl: 'https://api.openai.com',
          models: [{ id: 'm1' }],
        },
      ],
    }),
    getMcpServers: async () => [
      { serverId: 'mcp1', name: 'MCP 1', transport: 'stdio', enabled: true },
    ],
    getSession: async () => ({
      title: 'Test Session',
      events: [
        { seq: 1, ts: 100, type: 'message.created', message: { role: 'user', content: 'hello' } },
      ],
    }),
    getMainLogs: async () =>
      'Started app in C:\\Users\\alice\\AppData with key sk-11112222333344445555',
    getHostLogs: async () => 'Host running for C:/Users/alice/project',
    userHomeDir: 'C:\\Users\\alice',
  }

  it('builds summary correctly', async () => {
    const service = new DiagnosticsService(fakeDeps)
    const sum = await service.summary({ sessionId: 'session-123' })
    expect(sum.appVersion).toBe('1.2.3')
    expect(sum.session?.sessionId).toBe('session-123')
    expect(sum.exportItems).toContain('manifest.json')
    expect(sum.exportItems).toContain('session/events.json')
  })

  it('generates valid zip buffer free of real home paths and API keys', async () => {
    const service = new DiagnosticsService(fakeDeps)
    const zipBuffer = await service.createZipBuffer({ sessionId: 'session-123' })

    const unzipped = unzipSync(zipBuffer)
    const fileNames = Object.keys(unzipped)
    expect(fileNames).toContain('manifest.json')
    expect(fileNames).toContain('app-version.json')
    expect(fileNames).toContain('settings-summary.json')
    expect(fileNames).toContain('logs/main.log')
    expect(fileNames).toContain('logs/host.log')
    expect(fileNames).toContain('session/events.json')

    // Assert every file in the zip is sanitized
    for (const [name, content] of Object.entries(unzipped)) {
      const text = new TextDecoder().decode(content)
      expect(text, `Checking ${name} for home dir`).not.toContain('C:\\Users\\alice')
      expect(text, `Checking ${name} for forward home dir`).not.toContain('C:/Users/alice')
      expect(text, `Checking ${name} for api key 1`).not.toContain('sk-98765432101234567890')
      expect(text, `Checking ${name} for api key 2`).not.toContain('sk-11112222333344445555')
    }
  })

  it('exports zip and delegates to dialog/fs', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue('C:\\tmp\\test-diag.zip')
    const showItemInFolder = vi.fn()
    const service = new DiagnosticsService({
      ...fakeDeps,
      showSaveDialog,
      showItemInFolder,
    })

    const result = await service.export({ sessionId: 'session-123' })
    expect(result.cancelled).toBe(false)
    expect(result.path).toBe('C:\\tmp\\test-diag.zip')
    expect(showSaveDialog).toHaveBeenCalled()

    expect(service.showInFolder({ path: 'C:\\tmp\\test-diag.zip' })).toEqual({ shown: true })
    expect(showItemInFolder).toHaveBeenCalledWith('C:\\tmp\\test-diag.zip')
  })
})

describe('diagnostics edge branches', () => {
  it('handles empty text, empty home and empty secrets', () => {
    expect(sanitizeText('')).toBe('')
    expect(sanitizeText('C:\\Users\\alice\\x', '')).toBe('C:\\Users\\alice\\x')
    expect(sanitizeText('path C:\\Users\\alice\\', 'C:\\Users\\alice\\')).toBe('path ~\\')
    expect(redactSecrets('a b', ['', 'a'])).toBe('[REDACTED_CREDENTIAL] b')
  })

  it('summarizes settings with missing providers, models and urls', () => {
    const empty = summarizeSettings(undefined) as Record<string, unknown>
    expect(empty.providers).toEqual([])
    expect(empty.mcpServers).toEqual([])
    expect(empty.theme).toBe('system')

    const summary = summarizeSettings({
      providers: [
        { id: 'none', displayName: 'None' },
        { id: 'empty', baseUrl: '' },
        { id: 'bad', baseUrl: 'not a url' },
        { id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
        { id: 'deepseek', baseUrl: 'https://api.deepseek.com' },
        { id: 'openrouter', baseUrl: 'https://openrouter.ai/api' },
        { id: 'google', baseUrl: 'https://generativelanguage.googleapis.com' },
        { id: 'other', baseUrl: 'https://example.com', models: [{ id: 'm1' }] },
      ],
      theme: 'dark',
    })
    const providers = summary.providers as { isOfficialUrl: boolean }[]
    expect(providers.map((p) => p.isOfficialUrl)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      false,
      false,
    ])
    expect(summary.theme).toBe('dark')
  })

  it('summarizes mcp tool counts from toolCount or tools', () => {
    const summary = summarizeSettings(undefined, [
      { serverId: 'a', toolCount: 3 },
      { serverId: 'b', tools: [{}, {}] },
      { serverId: 'c' },
    ])
    expect((summary.mcpServers as { toolCount: number }[]).map((s) => s.toolCount)).toEqual([
      3, 2, 0,
    ])
  })

  it('keeps optional event fields and tool metadata in the default summary', () => {
    const clean = summarizeSessionEvents(
      [
        {
          seq: 1,
          ts: 1,
          type: 'turn.failed',
          turnId: 't1',
          runId: 'r1',
          error: { code: 'boom' },
          usage: { inputTokens: 1, outputTokens: 2 },
          model: { providerId: 'p', modelId: 'm' },
        },
        {
          seq: 2,
          ts: 2,
          type: 'tool.started',
          name: 'exec',
          status: 'running',
        },
        {
          seq: 3,
          ts: 3,
          type: 'message.created',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        },
      ],
      false,
      'C:\\Users\\alice',
    )
    expect(clean[0]).toMatchObject({
      turnId: 't1',
      runId: 'r1',
      error: { code: 'boom' },
      usage: { inputTokens: 1, outputTokens: 2 },
      model: { providerId: 'p', modelId: 'm' },
    })
    expect(clean[1]).toMatchObject({ toolName: 'exec', status: 'running' })
    expect(clean[2]).toMatchObject({
      role: 'user',
      contentLength: undefined,
      contentSummary: '[CONTENT_OMITTED_BY_DEFAULT]',
    })
  })

  it('summarizes without a session and tolerates empty logs', async () => {
    const service = new DiagnosticsService({
      getAppVersion: () => '1.0.0',
      getElectronVersion: () => '30.0.0',
      getSettings: async () => ({}),
      getMcpServers: async () => [],
      getSession: async () => undefined,
      getMainLogs: () => '',
      getHostLogs: async () => '',
    })
    const sum = await service.summary()
    expect(sum.logs).toEqual({ mainLogLines: 0, hostLogLines: 0 })
    expect(sum.settings.providersCount).toBe(0)
    expect(sum.session).toBeUndefined()
    expect(sum.exportItems).not.toContain('session/events.json')

    const missing = await service.summary({ sessionId: 'missing' })
    expect(missing.session).toBeUndefined()
  })

  it('omits session files when the session is missing and applies known secrets', async () => {
    const service = new DiagnosticsService({
      getAppVersion: () => '1.0.0',
      getElectronVersion: () => '30.0.0',
      getSettings: async () => ({}),
      getMcpServers: async () => [],
      getSession: async () => undefined,
      getMainLogs: () => 'secret-value',
      getHostLogs: () => 'host',
      getKnownSecrets: () => ['secret-value'],
    })
    const unzipped = unzipSync(await service.createZipBuffer({ sessionId: 'missing' }))
    expect(Object.keys(unzipped)).not.toContain('session/events.json')
    expect(new TextDecoder().decode(unzipped['logs/main.log']!)).toBe('[REDACTED_CREDENTIAL]')
  })

  it('includes sensitive session content when explicitly requested', async () => {
    const service = new DiagnosticsService({
      getAppVersion: () => '1.0.0',
      getElectronVersion: () => '30.0.0',
      getSettings: async () => ({}),
      getMcpServers: async () => [],
      getSession: async () => ({
        title: 'Session',
        events: [
          {
            seq: 1,
            ts: 1,
            type: 'message.created',
            message: { role: 'user', content: 'C:\\Users\\alice\\hello' },
          },
        ],
      }),
      getMainLogs: () => '',
      getHostLogs: () => '',
      userHomeDir: 'C:\\Users\\alice',
    })
    const unzipped = unzipSync(
      await service.createZipBuffer({ sessionId: 's1', includeSensitiveSessionContent: true }),
    )
    const text = new TextDecoder().decode(unzipped['session/events.json']!)
    expect(text).toContain('~\\\\hello')
    expect(text).not.toContain('C:\\\\Users\\\\alice')
  })

  it('returns cancelled when the save dialog is dismissed and handles missing reveal support', async () => {
    const service = new DiagnosticsService({
      getAppVersion: () => '1.0.0',
      getElectronVersion: () => '30.0.0',
      getSettings: async () => ({}),
      getMcpServers: async () => [],
      getSession: async () => undefined,
      getMainLogs: () => '',
      getHostLogs: () => '',
      showSaveDialog: async () => undefined,
    })
    expect(await service.export()).toEqual({ cancelled: true })
    expect(service.showInFolder({ path: 'x' })).toEqual({ shown: false })
  })
})
