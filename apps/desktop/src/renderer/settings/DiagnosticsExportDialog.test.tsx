// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { DiagnosticsSummary } from '@cairn/protocol'
import { DiagnosticsExportDialog } from './DiagnosticsExportDialog.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

afterEach(cleanup)

const i18n = createI18n('zh-CN')

const mockSummary: DiagnosticsSummary = {
  appVersion: '1.2.3',
  electronVersion: '30.0.0',
  build: {
    schemaVersion: 1,
    version: '1.2.3',
    channel: 'beta',
    commit: 'abcdef1234567890',
    buildTime: '2026-11-10T00:00:00.000Z',
    electronVersion: '30.0.0',
    nodeVersion: '24.0.0',
    name: 'Cairn',
    appId: 'com.cairn.desktop',
    copyright: 'Copyright © 2026 Cairn contributors',
    packaged: false,
    databaseSchemaVersion: 12,
  },
  platform: 'win32',
  arch: 'x64',
  logs: {
    mainLogLines: 150,
    hostLogLines: 80,
  },
  settings: {
    providersCount: 2,
    mcpServersCount: 1,
  },
  sandbox: {
    platform: 'win32',
    mechanism: 'restricted-token',
    policy: { profile: 'workspace-write', network: 'none' },
    unavailable: 'deny',
    capability: {
      available: true,
      supported: true,
      mechanism: 'restricted-token',
      networkIsolated: false,
      checks: { restrictedToken: true, lowIntegrity: true, jobObject: true, appContainer: false },
    },
  },
  session: {
    sessionId: 'session-123',
    title: '调试会话',
    eventsCount: 42,
    includeSensitiveContent: false,
  },
  exportItems: ['manifest.json', 'logs/main.log', 'session/events.json'],
}

describe('DiagnosticsExportDialog component', () => {
  it('loads summary, toggles sensitive content, and exports bundle', async () => {
    const onOpenChange = vi.fn()
    let exportParams: { includeSensitiveSessionContent?: boolean } | undefined
    let shownPath: string | undefined = undefined

    const fakeApi = {
      request: async (method: string, params: unknown) => {
        if (method === 'diagnostics.summary') return mockSummary
        if (method === 'diagnostics.export') {
          exportParams = params as { includeSensitiveSessionContent?: boolean }
          return { path: 'C:\\exports\\cairn-diag.zip', cancelled: false }
        }
        if (method === 'diagnostics.showInFolder') {
          shownPath = (params as { path: string }).path
          return {}
        }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)

    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <DiagnosticsExportDialog
            open={true}
            onOpenChange={onOpenChange}
            sessionId="session-123"
          />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )

    // Wait for summary to render
    await waitFor(() => {
      expect(screen.getByText(/调试会话/i)).toBeDefined()
      expect(screen.getByText(/1.2.3/i)).toBeDefined()
      expect(screen.getByText(/abcdef1/i)).toBeDefined()
      expect(screen.getByText(/命令沙箱: 工作区可写 · 受限令牌 · 网络未隔离/)).toBeDefined()
    })

    // Toggle include content
    const switchInput = screen.getByRole('switch')
    fireEvent.click(switchInput)
    await waitFor(() => {
      expect((screen.getByRole('switch') as HTMLButtonElement).getAttribute('aria-checked')).toBe(
        'true',
      )
    })

    // Click export button
    const exportBtn = screen.getByRole('button', { name: /导出诊断包/i })
    await waitFor(() => {
      expect((exportBtn as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(exportBtn)

    // Check success view
    await waitFor(() => {
      expect(screen.getByText('C:\\exports\\cairn-diag.zip')).toBeDefined()
      expect(exportParams?.includeSensitiveSessionContent).toBe(true)
    })

    // Click show in folder
    const showBtn = screen.getByRole('button', { name: /在文件夹中显示/i })
    fireEvent.click(showBtn)
    expect(shownPath).toBe('C:\\exports\\cairn-diag.zip')
  })

  it('stays on the summary view when the export is cancelled', async () => {
    const fakeApi = {
      request: async (method: string) => {
        if (method === 'diagnostics.summary') return { ...mockSummary, sandbox: undefined }
        if (method === 'diagnostics.export') return { cancelled: true }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <DiagnosticsExportDialog open={true} onOpenChange={() => {}} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    await waitFor(() => expect(screen.getByText(/1.2.3/i)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }))
    await waitFor(() => {
      expect(screen.queryByText('诊断包导出成功')).toBeNull()
      expect(screen.getByRole('button', { name: '导出诊断包' })).toBeTruthy()
    })
  })
})
