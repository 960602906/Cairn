// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown.js'

afterEach(() => {
  cleanup()
})

describe('Markdown 路径解析', () => {
  it('debounces resolution before making inline paths clickable', async () => {
    const resolvePaths = vi.fn(async () => new Map([['src/a.ts', 'src/a.ts']]))
    const onOpenFile = vi.fn()
    const { getByRole } = render(
      <Markdown
        text={'看 `src/a.ts:12`'}
        resolvePaths={resolvePaths}
        onOpenFile={onOpenFile}
        debounceMs={5}
      />,
    )

    await waitFor(() => expect(resolvePaths).toHaveBeenCalledWith(['src/a.ts']))
    const button = await waitFor(() => getByRole('button', { name: 'src/a.ts:12' }))
    fireEvent.click(button)
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts', 12)
  })

  it('makes file names in prose clickable, resolved to the real project path', async () => {
    const resolvePaths = vi.fn(
      async () =>
        new Map([
          ['AutofixSettings.tsx', 'apps/desktop/src/renderer/AutofixSettings.tsx'],
          ['renderer-gateway.ts', 'apps/desktop/src/main/services/renderer-gateway.ts'],
        ]),
    )
    const onOpenFile = vi.fn()
    const { getByRole, queryByRole } = render(
      <Markdown
        text={'改了 AutofixSettings.tsx 和 renderer-gateway.ts:604，还有 missing.ts'}
        resolvePaths={resolvePaths}
        onOpenFile={onOpenFile}
      />,
    )

    await waitFor(() =>
      expect(resolvePaths).toHaveBeenCalledWith([
        'AutofixSettings.tsx',
        'renderer-gateway.ts',
        'missing.ts',
      ]),
    )
    fireEvent.click(getByRole('button', { name: 'AutofixSettings.tsx' }))
    expect(onOpenFile).toHaveBeenCalledWith(
      'apps/desktop/src/renderer/AutofixSettings.tsx',
      undefined,
    )
    fireEvent.click(getByRole('button', { name: 'renderer-gateway.ts:604' }))
    expect(onOpenFile).toHaveBeenLastCalledWith(
      'apps/desktop/src/main/services/renderer-gateway.ts',
      604,
    )
    // 解析不到的文件名保持普通文字，不再是链接。
    expect(queryByRole('button', { name: 'missing.ts' })).toBeNull()
    expect(queryByRole('link', { name: 'missing.ts' })).toBeNull()
  })

  it('accepts a bare file name in inline code', async () => {
    const resolvePaths = vi.fn(async () => new Map([['README.md', 'docs/README.md']]))
    const onOpenFile = vi.fn()
    const { getByRole } = render(
      <Markdown text={'见 `README.md`'} resolvePaths={resolvePaths} onOpenFile={onOpenFile} />,
    )
    fireEvent.click(await waitFor(() => getByRole('button', { name: 'README.md' })))
    expect(resolvePaths).toHaveBeenCalledWith(['README.md'])
    expect(onOpenFile).toHaveBeenCalledWith('docs/README.md', undefined)
  })

  it('ignores a path check that finishes after unmount', async () => {
    let resolve!: (paths: ReadonlyMap<string, string>) => void
    const pending = new Promise<ReadonlyMap<string, string>>((done) => {
      resolve = done
    })
    const { unmount } = render(
      <Markdown text={'`src/a.ts`'} resolvePaths={() => pending} onOpenFile={vi.fn()} />,
    )
    unmount()
    await act(async () => {
      resolve(new Map([['src/a.ts', 'src/a.ts']]))
      await pending
    })
  })
})
