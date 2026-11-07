// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { DiagnosticsSummary } from '@cairn/protocol'
import { DiagnosticsExportDialog } from './DiagnosticsExportDialog.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

const i18n = createI18n('zh-CN')

const mockSummary: DiagnosticsSummary = {
  appVersion: '1.2.3',
  electronVersion: '30.0.0',
  platform: 'win32',
  arch: 'x64',
  logs: {
    mainLogLines: 150,
    hostLogLines: 80,
  },
  settings: {
    providersCount: 2,
    mcpServersCount: 1,
    hasAuxiliaryModel: true,
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
})
