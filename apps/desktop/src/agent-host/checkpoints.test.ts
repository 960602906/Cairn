import { CheckpointError, CheckpointErrorCode } from '@nexus/checkpoint'
import { describe, expect, it, vi } from 'vitest'
import { createHostCheckpoints, type OpenShadowRepo } from './checkpoints.js'

const location = { gitDir: '/data/p1.git', ref: 'refs/nexus/sessions/s1', workTree: '/work' }

function repo(head: string | undefined) {
  let n = 0
  const messages: string[] = []
  return {
    messages,
    repo: {
      head: () => head,
      checkpoint: vi.fn(async (message: string) => {
        messages.push(message)
        return { commit: `cp${++n}` } as never
      }),
    },
  }
}

describe('createHostCheckpoints', () => {
  it('opens on start, creates the first checkpoint in the background, then on demand', async () => {
    const r = repo(undefined)
    const open = vi.fn<OpenShadowRepo>(async () => r.repo)
    const checkpoints = createHostCheckpoints({ ...location, open })
    expect(open).toHaveBeenCalledWith(location)
    await expect(checkpoints.available()).resolves.toBe(true)
    await expect(checkpoints.create('turn_start')).resolves.toBe('cp2')
    await expect(checkpoints.create('before_command')).resolves.toBe('cp3')
    expect(r.messages).toEqual(['initial', 'turn start', 'before command'])
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not create an initial checkpoint when the session already has one', async () => {
    const r = repo('cp0')
    const checkpoints = createHostCheckpoints({ ...location, open: async () => r.repo })
    await expect(checkpoints.create('turn_start')).resolves.toBe('cp1')
    expect(r.messages).toEqual(['turn start'])
  })

  it('reports a failed background checkpoint', async () => {
    const onError = vi.fn()
    const failing = {
      head: () => undefined,
      checkpoint: () => Promise.reject(new Error('disk full')),
    }
    const checkpoints = createHostCheckpoints({ ...location, open: async () => failing, onError })
    await checkpoints.available()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error('disk full')))
  })

  it('is unavailable without Git', async () => {
    const onError = vi.fn()
    const unavailable = new CheckpointError(CheckpointErrorCode.GitUnavailable, 'git not_found')
    const open = vi.fn<OpenShadowRepo>(() => Promise.reject(unavailable))
    const checkpoints = createHostCheckpoints({ ...location, open, onError })
    await expect(checkpoints.create('turn_start')).resolves.toBeUndefined()
    await expect(checkpoints.available()).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith(unavailable)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('throws other open failures and retries next time', async () => {
    const r = repo('cp0')
    const open = vi
      .fn<OpenShadowRepo>()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValue(r.repo)
    const checkpoints = createHostCheckpoints({ ...location, open })
    await expect(checkpoints.create('before_command')).rejects.toThrow('EACCES')
    await expect(checkpoints.create('before_command')).resolves.toBe('cp1')
    expect(open).toHaveBeenCalledTimes(2)
  })
})
