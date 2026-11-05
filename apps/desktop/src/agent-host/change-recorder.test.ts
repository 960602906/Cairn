import { describe, expect, it, vi } from 'vitest'
import { CHANGE_RECORD_TIMEOUT_MS, createHostChangeRecorder } from './change-recorder.js'

describe('createHostChangeRecorder', () => {
  it('内容以 base64 经 changes.record 交给主进程', async () => {
    const request = vi.fn(async () => ({ changeId: 'ch1' }))
    const recorder = createHostChangeRecorder({ request } as never)
    const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]
    const bytes = Buffer.from('xxab')
    await expect(
      recorder.record({
        path: 'a.txt',
        kind: 'modify',
        before: new Uint8Array([0xff, 0x00]),
        after: bytes.subarray(2),
        hunks,
        added: 1,
        removed: 1,
        toolCallId: 'c1',
        turnId: 't1',
      }),
    ).resolves.toEqual({ changeId: 'ch1' })
    expect(request).toHaveBeenCalledWith(
      'changes.record',
      {
        path: 'a.txt',
        kind: 'modify',
        before: '/wA=',
        after: 'YWI=',
        toolCallId: 'c1',
        turnId: 't1',
        hunks,
        added: 1,
        removed: 1,
      },
      { timeoutMs: CHANGE_RECORD_TIMEOUT_MS },
    )
    await recorder.record({
      path: 'n',
      kind: 'create',
      after: new Uint8Array(),
      hunks: [],
      added: 0,
      removed: 0,
      toolCallId: 'c2',
    })
    expect(request).toHaveBeenLastCalledWith(
      'changes.record',
      { path: 'n', kind: 'create', after: '', toolCallId: 'c2', hunks: [], added: 0, removed: 0 },
      { timeoutMs: CHANGE_RECORD_TIMEOUT_MS },
    )
  })
})
