// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComponentPreview } from './ComponentPreview.js'

afterEach(cleanup)

describe('ComponentPreview', () => {
  it('renders the components and switches the theme', async () => {
    const root = { setAttribute: vi.fn() }
    render(<ComponentPreview initialTheme="tundra" env={{ root }} />)
    expect(screen.getByRole('heading', { name: '组件预览' })).toBeTruthy()
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'tundra')
    await userEvent.click(screen.getByRole('radio', { name: '黑曜' }))
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'obsidian')
    await userEvent.click(screen.getByRole('switch', { name: '启用' }))
    expect(screen.getByRole('switch', { name: '启用' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('figure', { name: '代码：src/sum.mjs' })).toBeTruthy()
    expect(screen.getByRole('figure', { name: '终端：npm test' })).toBeTruthy()
  })
})
