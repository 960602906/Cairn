// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComponentPreview } from './ComponentPreview.js'

afterEach(cleanup)

describe('ComponentPreview', () => {
  it('renders the components and switches the theme', async () => {
    const root = { setAttribute: vi.fn() }
    render(<ComponentPreview initialTheme="light" env={{ root }} />)
    expect(screen.getByRole('heading', { name: '组件预览' })).toBeTruthy()
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'light')
    await userEvent.click(screen.getByRole('radio', { name: '深色' }))
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'dark')
    await userEvent.click(screen.getByRole('switch', { name: '启用' }))
    expect(screen.getByRole('switch', { name: '启用' }).getAttribute('aria-checked')).toBe('false')
  })
})
