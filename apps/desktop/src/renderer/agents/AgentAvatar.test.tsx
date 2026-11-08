// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AGENT_COLOR_NAMES, AGENT_ICON_NAMES, AgentAvatar } from './AgentAvatar.js'

describe('AgentAvatar', () => {
  it('renders default icon when none provided', () => {
    const { container } = render(<AgentAvatar />)
    expect(container.querySelector('svg')).toBeDefined()
  })

  it('renders custom icon and color token class', () => {
    const { container } = render(
      <AgentAvatar icon="code" color="agent-blue" size={32} className="custom-class" />,
    )
    const root = container.firstElementChild
    expect(root).toBeDefined()
    expect(root?.className).toContain('custom-class')
    expect(container.querySelector('svg')).toBeDefined()
  })

  it('falls back for unknown icon and color names', () => {
    const { container } = render(<AgentAvatar icon="nope" color="nope" />)
    expect(container.firstElementChild?.className).toContain('bg-accent-soft')
    expect(container.querySelector('svg')).toBeDefined()
  })

  it('has all defined color names and icon names', () => {
    expect(AGENT_COLOR_NAMES.length).toBeGreaterThan(0)
    expect(AGENT_ICON_NAMES.length).toBeGreaterThan(0)
    for (const color of AGENT_COLOR_NAMES) {
      const { container } = render(<AgentAvatar color={color} />)
      expect(container.firstElementChild).toBeDefined()
    }
    for (const icon of AGENT_ICON_NAMES) {
      const { container } = render(<AgentAvatar icon={icon} />)
      expect(container.querySelector('svg')).toBeDefined()
    }
  })
})
