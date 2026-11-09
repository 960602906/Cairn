import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsEmpty } from './Field.js'
import { SkillGlyph } from './SettingIcons.js'

describe('settings primitives', () => {
  it('renders an optional empty-state action', () => {
    const withAction = renderToStaticMarkup(
      <SettingsEmpty
        icon={<span />}
        title="Empty"
        description="Nothing here."
        action={<button type="button">Create</button>}
      />,
    )
    expect(withAction).toContain('Create')

    const withoutAction = renderToStaticMarkup(
      <SettingsEmpty icon={<span />} title="Empty" description="Nothing here." />,
    )
    expect(withoutAction).not.toContain('<button')
  })

  it('renders the skill glyph with or without an accessible title', () => {
    const untitled = renderToStaticMarkup(<SkillGlyph />)
    expect(untitled).toContain('aria-hidden="true"')
    expect(untitled).not.toContain('<title>')

    const titled = renderToStaticMarkup(<SkillGlyph title="Skills" />)
    expect(titled).not.toContain('aria-hidden="true"')
    expect(titled).toContain('<title>Skills</title>')
  })
})
