// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CairnMark } from './CairnMark.js'

afterEach(cleanup)

describe('CairnMark', () => {
  it('renders the halo C at the requested size', () => {
    const { container } = render(<CairnMark size={48} className="text-accent" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('48')
    expect(svg.getAttribute('height')).toBe('48')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.querySelectorAll('path')).toHaveLength(1)
    expect(svg.querySelectorAll('circle')).toHaveLength(1)
    expect(svg.querySelector('path')!.getAttribute('stroke')).toBe('currentColor')
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
