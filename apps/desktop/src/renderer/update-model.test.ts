import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@cairn/protocol'
import {
  formatBytes,
  formatSpeed,
  hasRunningSessions,
  installBlocked,
  noticeKey,
  noticeKind,
  progressPercent,
} from './update-model.js'

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: 'idle',
    currentVersion: '0.1.0',
    channel: 'beta',
    channelPinned: false,
    enabled: true,
    autoCheck: true,
    signatureVerified: false,
    requiresRestart: false,
    ...overrides,
  }
}

describe('hasRunningSessions', () => {
  it('counts running and waiting-for-approval sessions', () => {
    expect(hasRunningSessions([])).toBe(false)
    expect(hasRunningSessions([{ status: 'idle' }, { status: 'failed' }])).toBe(false)
    expect(hasRunningSessions([{ status: 'running' }])).toBe(true)
    expect(hasRunningSessions([{ status: 'waiting_approval' }])).toBe(true)
  })
})

describe('noticeKey and noticeKind', () => {
  it('keeps the key stable within a phase and version', () => {
    expect(noticeKey(status({ phase: 'available', availableVersion: '0.1.1' }))).toBe(
      'available:0.1.1',
    )
    expect(noticeKey(status({ phase: 'downloaded', availableVersion: '0.1.1' }))).toBe(
      'downloaded:0.1.1',
    )
    expect(noticeKey(status())).toBe('idle:0.1.0')
  })

  it('hides without a status or in quiet phases', () => {
    expect(noticeKind(undefined, undefined)).toBeUndefined()
    for (const phase of [
      'disabled',
      'idle',
      'checking',
      'up_to_date',
      'verifying',
      'installing',
      'skipped',
      'error',
    ] as const) {
      expect(noticeKind(status({ phase }), undefined)).toBeUndefined()
    }
  })

  it('shows available, downloading and downloaded notices', () => {
    expect(noticeKind(status({ phase: 'available', availableVersion: '0.1.1' }), undefined)).toBe(
      'available',
    )
    expect(noticeKind(status({ phase: 'downloading' }), undefined)).toBe('downloading')
    expect(noticeKind(status({ phase: 'downloaded' }), undefined)).toBe('downloaded')
  })

  it('honours dismissal for the current available version only', () => {
    const available = status({ phase: 'available', availableVersion: '0.1.1' })
    expect(noticeKind(available, noticeKey(available))).toBeUndefined()
    expect(noticeKind({ ...available, availableVersion: '0.1.2' }, noticeKey(available))).toBe(
      'available',
    )
    expect(noticeKind({ ...available, phase: 'downloaded' }, noticeKey(available))).toBe(
      'downloaded',
    )
  })
})

describe('installBlocked', () => {
  it('blocks on the main-process reason or known running sessions', () => {
    expect(installBlocked(status({ phase: 'downloaded' }), false)).toBe(false)
    expect(
      installBlocked(status({ phase: 'downloaded', blockedReason: 'update.busy' }), false),
    ).toBe(true)
    expect(installBlocked(status({ phase: 'downloaded' }), true)).toBe(true)
  })
})

describe('formatBytes', () => {
  it('formats units without trailing zeros', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(5.5 * 1024 * 1024 * 1024)).toBe('5.5 GB')
  })

  it('rolls over to the next unit when rounding reaches 1024', () => {
    expect(formatBytes(1023.6 * 1024)).toBe('1 MB')
  })
})

describe('formatSpeed', () => {
  it('only formats positive finite speeds', () => {
    expect(formatSpeed(undefined)).toBeUndefined()
    expect(formatSpeed(0)).toBeUndefined()
    expect(formatSpeed(-2)).toBeUndefined()
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2 MB/s')
  })
})

describe('progressPercent', () => {
  it('rounds and clamps progress', () => {
    expect(progressPercent(status())).toBe(0)
    expect(progressPercent(status({ progress: { percent: 42.6, transferred: 1, total: 2 } }))).toBe(
      43,
    )
    expect(progressPercent(status({ progress: { percent: 140, transferred: 1, total: 2 } }))).toBe(
      100,
    )
    expect(progressPercent(status({ progress: { percent: -3, transferred: 1, total: 2 } }))).toBe(0)
    expect(
      progressPercent(status({ progress: { percent: Number.NaN, transferred: 1, total: 2 } })),
    ).toBe(0)
  })
})
