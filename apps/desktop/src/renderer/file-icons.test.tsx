// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

/** 图标映射是模块级状态：每个用例重新导入，才能看到"加载前"的首帧。 */
async function load() {
  vi.resetModules()
  return import('./file-icons.js')
}

describe('文件图标', () => {
  it('映射加载前先给通用图标，加载后换成具体图标', async () => {
    const { FileTypeIcon } = await load()
    const { container } = render(<FileTypeIcon name="index.ts" />)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('./file.svg')

    await waitFor(() => expect(image?.getAttribute('src')).toBe('./typescript.svg'))
  })

  it('目录图标去掉路径前缀，展开时用 -open 变体', async () => {
    const { FolderTypeIcon } = await load()
    const { container } = render(<FolderTypeIcon name={'C:\\work\\src\\'} expanded />)
    const image = container.querySelector('img')

    await waitFor(() => expect(image?.getAttribute('src')).toBe('./folder-src-open.svg'))
  })
})
