// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { GPL_SOURCE_URL, GplSourceDialog, MINGIT_VERSION, PrivacyDialog } from './LegalDialogs.js'

afterEach(cleanup)

function renderWithI18n(node: React.ReactNode) {
  render(<I18nextProvider i18n={createI18n('zh-CN')}>{node}</I18nextProvider>)
}

describe('PrivacyDialog', () => {
  it('describes local data, providers, updates and retention', async () => {
    const onOpenChange = vi.fn()
    renderWithI18n(<PrivacyDialog open onOpenChange={onOpenChange} />)
    expect(screen.getByRole('heading', { name: '隐私说明' })).toBeDefined()
    for (const title of [
      '账号与遥测',
      '本机数据',
      '模型请求',
      'API Key 与凭据',
      '更新检查',
      '诊断包',
      '技能与 MCP',
      '保留与删除',
      '说明变更',
    ]) {
      expect(screen.getByText(title)).toBeDefined()
    }
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('GplSourceDialog', () => {
  it('shows the bundled version, source URL and license location', async () => {
    const onOpenChange = vi.fn()
    renderWithI18n(<GplSourceDialog open onOpenChange={onOpenChange} />)
    expect(screen.getByRole('heading', { name: 'GPL 源码获取方式' })).toBeDefined()
    expect(screen.getByText(`随包版本：MinGit ${MINGIT_VERSION}`)).toBeDefined()
    expect(screen.getByText(GPL_SOURCE_URL)).toBeDefined()
    const link = screen.getByRole('link', { name: '打开源码页面' })
    expect(link.getAttribute('href')).toBe(GPL_SOURCE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(screen.getByText(/THIRD_PARTY_NOTICES\.txt/)).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
