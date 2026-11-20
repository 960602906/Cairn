import { describe, expect, it } from 'vitest'
import { fileIconUrl, folderIconUrl } from './file-icon-map.js'

describe('material icon urls', () => {
  it('matches files by name and falls back for unknown types', () => {
    expect(fileIconUrl('index.ts')).toBe('./typescript.svg')
    expect(fileIconUrl('package.json')).toBe('./nodejs.svg')
    expect(fileIconUrl('mystery.zzz')).toBe('./file.svg')
  })

  it('matches folders by name and switches to the open variant', () => {
    expect(folderIconUrl('src')).toBe('./folder-src.svg')
    expect(folderIconUrl('src', true)).toBe('./folder-src-open.svg')
    expect(folderIconUrl('.package')).toBe('./folder-packages.svg')
    expect(folderIconUrl('e2e')).toBe('./folder-coverage.svg')
    expect(folderIconUrl('unknown-folder')).toBe('./folder.svg')
    expect(folderIconUrl('unknown-folder', true)).toBe('./folder-open.svg')
  })

  it('falls back to the default icon when the path has no name segment', () => {
    expect(fileIconUrl('')).toBe('./file.svg')
  })
})
