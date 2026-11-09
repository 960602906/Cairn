/**
 * 多会话并发的性能与资源验收（M4-13）。
 *
 * 只在 `CAIRN_PERF` 下运行（`pnpm test:perf`）：3 个会话同时逐字流式输出，测量总耗时、
 * 事件之间的最大停顿与堆增长，最后确认空闲宿主按时回收。阈值取得很宽松，目的是发现
 * 调度退化与泄漏，不是基准测试。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@cairn/core'
import type { RpcChannel } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createAgentHost } from '../../agent-host/host.js'
import { createFakeHostRuntime } from '../../agent-host/fake-model.js'
import { createSessionEventService } from './event-service.js'
import type { HostProcess } from './host-process.js'
import { createHostSupervisor } from './host-supervisor.js'
import { createSessionManager, type SessionManager } from './session-manager.js'

/** 每个会话的流式字符数。 */
const CHARS = 3000
const SESSIONS = 3
/** 基线：在 CI 的两端平台上都远低于这个上限。 */
const MAX_TOTAL_MS = 20_000
const MAX_EVENT_GAP_MS = 1_000
const MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024

function channelPair(): [RpcChannel, RpcChannel] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()]
  const make = (self: 0 | 1): RpcChannel => ({
    post(message) {
      const copy = structuredClone(message)
      queueMicrotask(() => listeners[self === 0 ? 1 : 0].forEach((l) => l(copy)))
    },
    onMessage(listener) {
      listeners[self].add(listener)
      return () => listeners[self].delete(listener)
    },
  })
  return [make(0), make(1)]
}

const SCRIPT: FakeScript = { turns: [], chunkSize: 1, delayMs: 0 }
const text = (value: string) => [{ type: 'text' as const, text: value }]

let manager: SessionManager | undefined

afterEach(async () => {
  await manager?.shutdown()
  manager = undefined
})

function spawn(): HostProcess {
  const [mainSide, hostSide] = channelPair()
  const exitListeners: ((code: number) => void)[] = []
  let alive = true
  let ids = 0
  const exit = (code: number) => {
    if (!alive) return
    alive = false
    for (const listener of exitListeners) listener(code)
  }
  createAgentHost({
    channel: hostSide,
    createRuntime: (model) => createFakeHostRuntime(model, SCRIPT),
    exit,
    createId: () => `perf-${++ids}`,
  })
  return {
    channel: mainSide,
    pid: 1,
    kill: () => exit(-1),
    onExit: (listener) => exitListeners.push(listener),
  }
}

describe.runIf(process.env['CAIRN_PERF'])('multi-session streaming performance (M4-13)', () => {
  it(
    'streams three sessions concurrently without long pauses or heap growth',
    { timeout: 120_000 },
    async () => {
      const storage = createMemoryStorage()
      const events = createSessionEventService({ storage })
      const supervisor = createHostSupervisor({ spawn, events })
      manager = createSessionManager({
        storage,
        events,
        supervisor,
        runDefaults: {
          agent: { id: 'default', version: 1 },
          model: { providerId: 'fake', modelId: 'fake' },
          mode: 'interactive',
          limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 3 },
        },
        idleTimeoutMs: 200,
      })

      const sessionIds = Array.from(
        { length: SESSIONS },
        (_, index) => manager!.create({ projectPath: `/perf-${index}` }).sessionId,
      )
      const payload = text('x'.repeat(CHARS))

      let lastEventAt = 0
      let maxGap = 0
      /** 增量事件不落库，只能从订阅里统计。 */
      const deltas = new Map<string, number>()
      const firstDeltaAt = new Map<string, number>()
      const lastDeltaAt = new Map<string, number>()
      const off = events.subscribe((sessionId, batch) => {
        const now = performance.now()
        if (lastEventAt > 0) maxGap = Math.max(maxGap, now - lastEventAt)
        lastEventAt = now
        expect(batch.length).toBeGreaterThan(0)
        for (const event of batch) {
          if (event.type !== 'message.assistant.delta') continue
          expect(event.sessionId).toBe(sessionId)
          if (!firstDeltaAt.has(sessionId)) firstDeltaAt.set(sessionId, now)
          lastDeltaAt.set(sessionId, now)
          deltas.set(sessionId, (deltas.get(sessionId) ?? 0) + 1)
        }
      })

      const heapBefore = process.memoryUsage().heapUsed
      const startedAt = performance.now()
      for (const sessionId of sessionIds) {
        manager.prompt({ sessionId, content: payload })
      }
      await Promise.all(
        sessionIds.map(
          (sessionId) =>
            new Promise<void>((resolve) => {
              const unsubscribe = events.subscribe((id, batch) => {
                if (id !== sessionId) return
                if (!batch.some((event) => event.type === 'turn.completed')) return
                unsubscribe()
                resolve()
              })
              const done = events
                .readAfter(sessionId, 0)
                .some((event) => event.type === 'turn.completed')
              if (done) {
                unsubscribe()
                resolve()
              }
            }),
        ),
      )
      const elapsed = performance.now() - startedAt
      off()

      // 事件全部落在各自的会话里，每个会话都有完整的流式输出
      for (const sessionId of sessionIds) {
        expect(deltas.get(sessionId)).toBe(CHARS)
        expect(
          events.readAfter(sessionId, 0).some((event) => event.type === 'turn.completed'),
        ).toBe(true)
      }
      expect(Math.max(...firstDeltaAt.values())).toBeLessThan(Math.min(...lastDeltaAt.values()))
      expect(elapsed).toBeLessThan(MAX_TOTAL_MS)
      expect(maxGap).toBeLessThan(MAX_EVENT_GAP_MS)
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(MAX_HEAP_GROWTH_BYTES)

      // 空闲宿主按时回收：3 个宿主都在 idleTimeoutMs 之后释放名额
      await expect
        .poll(() => manager!.activeSessions(), { timeout: 10_000, interval: 50 })
        .toEqual([])
    },
  )
})
