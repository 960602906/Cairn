// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown.js'

afterEach(() => {
  cleanup()
})

describe('Markdown 路径解析', () => {
  it('debounces resolution before making inline paths clickable', async () => {
    const resolvePaths = vi.fn(async () => new Set(['src/a.ts']))
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

  it('ignores a path check that finishes after unmount', async () => {
    let resolve!: (paths: ReadonlySet<string>) => void
    const pending = new Promise<ReadonlySet<string>>((done) => {
      resolve = done
    })
    const { unmount } = render(
      <Markdown text={'`src/a.ts`'} resolvePaths={() => pending} onOpenFile={vi.fn()} />,
    )
    unmount()
    await act(async () => {
      resolve(new Set(['src/a.ts']))
      await pending
    })
  })
})
