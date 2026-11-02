import { RunState } from '@nexus/protocol'
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_RUN_STATES,
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
  RunStateErrorCode,
  acceptsInput,
  canTransition,
  isActiveRunState,
  transition,
} from './index.js'

/**
 * 合法转换的独立清单（按 Runtime §5.2 逐条写出），与实现中的表互相校验。
 * 修改状态机时两处都要改，避免误改转换表而测试仍然通过。
 */
const LEGAL = new Set([
  // 输入
  'idle>thinking',
  'completed>thinking',
  'failed>thinking',
  'interrupted>thinking',
  // 模型与工具
  'thinking>tooling',
  'thinking>completed',
  'tooling>thinking',
  'tooling>awaiting_approval',
  'awaiting_approval>tooling',
  'tooling>awaiting_children',
  'awaiting_children>tooling',
  // 停止
  'thinking>aborting',
  'tooling>aborting',
  'awaiting_approval>aborting',
  'awaiting_children>aborting',
  'aborting>idle',
  // 失败
  'thinking>failed',
  'tooling>failed',
  'awaiting_approval>failed',
  'awaiting_children>failed',
  // 进程退出
  'thinking>interrupted',
  'tooling>interrupted',
  'awaiting_approval>interrupted',
  'awaiting_children>interrupted',
  'aborting>interrupted',
  // 归档或删除
  'idle>disposed',
  'completed>disposed',
  'failed>disposed',
  'interrupted>disposed',
])

const ALL_PAIRS = RUN_STATES.flatMap((from) => RUN_STATES.map((to) => [from, to] as const))

describe('运行状态', () => {
  it('与 protocol 的 RunState 一致，共 10 个', () => {
    expect(RUN_STATES).toEqual(RunState.options)
    expect(RUN_STATES).toHaveLength(10)
  })

  it('转换表覆盖每个状态，且目标都是已知状态', () => {
    expect(Object.keys(RUN_STATE_TRANSITIONS).sort()).toEqual([...RUN_STATES].sort())
    for (const targets of Object.values(RUN_STATE_TRANSITIONS)) {
      for (const to of targets) expect(RUN_STATES).toContain(to)
      expect(new Set(targets).size).toBe(targets.length)
    }
  })

  it('独立清单中的转换都是已知状态', () => {
    for (const pair of LEGAL) {
      const [from, to] = pair.split('>')
      expect(RUN_STATES).toContain(from)
      expect(RUN_STATES).toContain(to)
    }
  })
})

describe('transition：全部 100 种组合', () => {
  it.each(ALL_PAIRS)('%s → %s', (from, to) => {
    const legal = LEGAL.has(`${from}>${to}`)
    expect(canTransition(from, to)).toBe(legal)
    const result = transition(from, to)
    if (legal) {
      expect(result).toEqual({ ok: true, state: to })
    } else {
      expect(result).toEqual({
        ok: false,
        error: { code: RunStateErrorCode.InvalidTransition, params: { from, to } },
      })
    }
  })

  it('合法转换共 29 条', () => {
    expect(ALL_PAIRS.filter(([from, to]) => canTransition(from, to))).toHaveLength(LEGAL.size)
    expect(LEGAL.size).toBe(29)
  })
})

describe('状态性质', () => {
  it('不允许自转换', () => {
    for (const s of RUN_STATES) expect(canTransition(s, s)).toBe(false)
  })

  it('disposed 是终态', () => {
    for (const s of RUN_STATES) expect(canTransition('disposed', s)).toBe(false)
  })

  it('每个非终态都能到达 disposed', () => {
    const reachesDisposed = (start: RunState): boolean => {
      const seen = new Set<RunState>([start])
      const queue: RunState[] = [start]
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
        if (s === 'disposed') return true
        for (const next of RUN_STATE_TRANSITIONS[s]) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      return false
    }
    for (const s of RUN_STATES) expect(reachesDisposed(s)).toBe(true)
  })

  it('运行中状态都可以停止、失败、中断，且不能直接归档', () => {
    for (const s of ACTIVE_RUN_STATES) {
      expect(canTransition(s, 'aborting')).toBe(true)
      expect(canTransition(s, 'failed')).toBe(true)
      expect(canTransition(s, 'interrupted')).toBe(true)
      expect(canTransition(s, 'disposed')).toBe(false)
    }
  })

  it('isActiveRunState 只对四个运行中状态为真', () => {
    expect(RUN_STATES.filter(isActiveRunState)).toEqual([
      'thinking',
      'tooling',
      'awaiting_approval',
      'awaiting_children',
    ])
  })

  it('acceptsInput 只对空闲、已完成、失败、中断为真', () => {
    expect(RUN_STATES.filter(acceptsInput)).toEqual(['idle', 'completed', 'failed', 'interrupted'])
  })
})
