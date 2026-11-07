// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CairnMark } from './CairnMark.js'

afterEach(cleanup)

describe('CairnMark', () => {
  it('renders three stones at the requested size and follows the current colour', () => {
    const { container } = render(<CairnMark size={48} className="text-accent" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('48')
    expect(svg.getAttribute('height')).toBe('48')
    expect(svg.querySelectorAll('path')).toHaveLength(3)
    expect(svg.classList.contains('fill-current')).toBe(true)
    expect(svg.classList.contains('text-accent')).toBe(true)
  })

  it('is decorative without a label and an image with one', () => {
    const { container, rerender } = render(<CairnMark />)
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('svg')!.hasAttribute('role')).toBe(false)

    rerender(<CairnMark label="Cairn" />)
    expect(screen.getByRole('img', { name: 'Cairn' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Cairn' }).getAttribute('aria-hidden')).toBeNull()
  })
})
