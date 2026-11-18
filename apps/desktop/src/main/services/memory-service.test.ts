import { BUILTIN_CODER } from '@cairn/core'
import type { AgentDefinition, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { describe, expect, it } from 'vitest'
import { createMemoryService, MemoryErrorCode } from './memory-service.js'

const agent = { id: BUILTIN_CODER.id, version: 1 }

function setup(
  options: {
    readonly memory?: Partial<AgentDefinition['memory']>
    readonly autoWriteEnabled?: boolean
    readonly definition?: AgentDefinition | 'missing'
  } = {},
) {
  const storage = createMemoryStorage()
  storage.projects.create({ projectId: 'p1', name: 'A', path: '/work/a' })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: '/work/a',
    title: 'A1',
  })
  const definition =
    options.definition === 'missing'
      ? undefined
      : options.definition !== undefined
        ? options.definition
        : { ...BUILTIN_CODER, memory: { ...BUILTIN_CODER.memory, ...options.memory } }
  const published: UnsequencedEvent[] = []
  let nextId = 0
  const service = createMemoryService({
    storage,
    events: {
      publish: (events) => {
        published.push(...events)
        return []
      },
    },
    definition: () => definition,
    autoWriteEnabled: () => options.autoWriteEnabled === true,
    createId: () => `mem-${++nextId}`,
    now: () => 456,
  })
  return { service, storage, published, definition }
}

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected:${String(error)}`
  }
}

describe('createMemoryService：写入（M7-03）', () => {
  it('propose：落库为待确认，记录来源并发布 memory.proposed', () => {
    const { service, storage, published } = setup()
    expect(
      service.remember({
        sessionId: 's1',
        runId: 'r1',
        agent,
        scope: 'project',
        content: '  提交信息用中文  ',
      }),
    ).toEqual({ memoryId: 'mem-1', status: 'proposed' })
    expect(storage.memories.get('mem-1')).toMatchObject({
      memoryId: 'mem-1',
      scope: 'project',
      projectId: 'p1',
      content: '提交信息用中文',
      status: 'proposed',
      sourceRunId: 'r1',
      sourceAgentId: BUILTIN_CODER.id,
    })
    expect(published).toEqual([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 456,
        type: 'memory.proposed',
        payload: {
          memoryId: 'mem-1',
          scope: 'project',
          content: '提交信息用中文',
          sourceAgentId: BUILTIN_CODER.id,
        },
      },
    ])
  })

  it('session 范围的记忆归属当前会话', () => {
    const { service, storage } = setup()
    service.remember({ sessionId: 's1', runId: 'r1', agent, scope: 'session', content: 'x' })
    expect(storage.memories.get('mem-1')).toMatchObject({ scope: 'session', sessionId: 's1' })
  })

  it('auto：Agent 配置为 auto 且设置允许时直接生效', () => {
    const { service, storage, published } = setup({
      memory: { write: 'auto' },
      autoWriteEnabled: true,
    })
    expect(
      service.remember({ sessionId: 's1', runId: 'r1', agent, scope: 'session', content: 'x' }),
    ).toEqual({ memoryId: 'mem-1', status: 'active' })
    expect(storage.memories.get('mem-1')?.status).toBe('active')
    expect(published.map((event) => event.type)).toEqual(['memory.accepted'])
    expect(published[0]?.payload).toMatchObject({ origin: 'auto' })
  })

  it('auto 但设置未开启时退回提议', () => {
    const { service, storage, published } = setup({ memory: { write: 'auto' } })
    expect(
      service.remember({ sessionId: 's1', runId: 'r1', agent, scope: 'session', content: 'x' })
        .status,
    ).toBe('proposed')
    expect(storage.memories.get('mem-1')?.status).toBe('proposed')
    expect(published.map((event) => event.type)).toEqual(['memory.proposed'])
  })

  it('Agent 未配置记忆或写入为 never 时拒绝，不落库', () => {
    const { storage, published } = setup({ memory: { write: 'never' } })
    const never = setup({ memory: { write: 'never' } }).service
    expect(
      errorCode(() =>
        never.remember({ sessionId: 's1', runId: 'r1', agent, scope: 'session', content: 'x' }),
      ),
    ).toBe(MemoryErrorCode.Disabled)
    const missing = setup({ definition: 'missing' }).service
    expect(
      errorCode(() =>
        missing.remember({ sessionId: 's1', runId: 'r1', agent, scope: 'session', content: 'x' }),
      ),
    ).toBe(MemoryErrorCode.Disabled)
    expect(storage.memories.list({ sessionId: 's1', projectId: 'p1' })).toEqual([])
    expect(published).toEqual([])
  })

  it('范围不在 Agent 的 scopes 里时拒绝', () => {
    const { service } = setup({ memory: { scopes: ['session'] } })
    expect(
      errorCode(() =>
        service.remember({ sessionId: 's1', runId: 'r1', agent, scope: 'global', content: 'x' }),
      ),
    ).toBe(MemoryErrorCode.ScopeNotAllowed)
  })

  it('会话不存在时报 storage.not_found', () => {
    const { service } = setup()
    expect(
      errorCode(() =>
        service.remember({ sessionId: 's9', runId: 'r1', agent, scope: 'session', content: 'x' }),
      ),
    ).toBe('storage.not_found')
  })
})

describe('createMemoryService：确认与忽略（M7-03）', () => {
  const propose = (options: Parameters<typeof setup>[0] = {}) => {
    const harness = setup(options)
    harness.service.remember({
      sessionId: 's1',
      runId: 'r1',
      agent,
      scope: 'project',
      content: '提交信息用中文',
    })
    harness.published.length = 0
    return harness
  }

  it('确认后条目生效，事件属于提议它的那一轮', () => {
    const { service, storage, published } = propose()
    expect(service.respond({ sessionId: 's1', memoryId: 'mem-1', action: 'accept' })).toEqual({})
    expect(storage.memories.get('mem-1')?.status).toBe('active')
    expect(published).toEqual([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 456,
        type: 'memory.accepted',
        payload: {
          memoryId: 'mem-1',
          scope: 'project',
          content: '提交信息用中文',
          origin: 'propose',
        },
      },
    ])
  })

  it('忽略后删除条目并发布 memory.rejected', () => {
    const { service, storage, published } = propose()
    expect(service.respond({ sessionId: 's1', memoryId: 'mem-1', action: 'reject' })).toEqual({})
    expect(storage.memories.get('mem-1')).toBeUndefined()
    expect(published.map((event) => event.type)).toEqual(['memory.rejected'])
  })

  it('重复确认是界面重复提交，不报错也不再写事件', () => {
    const { service, published } = propose()
    service.respond({ sessionId: 's1', memoryId: 'mem-1', action: 'accept' })
    published.length = 0
    expect(service.respond({ sessionId: 's1', memoryId: 'mem-1', action: 'accept' })).toEqual({})
    expect(published).toEqual([])
  })

  it('已经生效的条目不能再忽略', () => {
    const { service } = propose()
    service.respond({ sessionId: 's1', memoryId: 'mem-1', action: 'accept' })
    expect(
      errorCode(() => service.respond({ sessionId: 's1', memoryId: 'mem-1', action: 'reject' })),
    ).toBe(MemoryErrorCode.AlreadyHandled)
  })

  it('条目不存在时报 memory.not_found', () => {
    const { service } = setup()
    expect(
      errorCode(() => service.respond({ sessionId: 's1', memoryId: 'missing', action: 'accept' })),
    ).toBe(MemoryErrorCode.NotFound)
  })
})

describe('createMemoryService：管理界面（M7-04）', () => {
  const seed = () => {
    const harness = setup()
    harness.storage.memories.propose({ memoryId: 'g1', scope: 'global', content: '全局偏好' })
    harness.storage.memories.confirm('g1')
    harness.service.remember({
      sessionId: 's1',
      runId: 'r1',
      agent,
      scope: 'project',
      content: '项目约定',
    })
    return harness
  }

  it('列出全部范围，可按范围与状态筛选', () => {
    const { service } = seed()
    expect(service.list().entries.map((entry) => entry.memoryId)).toEqual(['mem-1', 'g1'])
    expect(service.list({ scope: 'global' }).entries.map((entry) => entry.memoryId)).toEqual(['g1'])
    expect(service.list({ status: 'proposed' }).entries.map((entry) => entry.memoryId)).toEqual([
      'mem-1',
    ])
  })

  it('编辑正文并更新更新时间', () => {
    const { service, storage } = seed()
    const { entry } = service.update({ memoryId: 'mem-1', content: '  新的约定  ' })
    expect(entry).toMatchObject({ memoryId: 'mem-1', content: '  新的约定  ' })
    expect(storage.memories.get('mem-1')?.content).toBe('  新的约定  ')
  })

  it('编辑不存在或空内容时报错', () => {
    const { service } = seed()
    expect(errorCode(() => service.update({ memoryId: 'missing', content: 'x' }))).toBe(
      MemoryErrorCode.NotFound,
    )
    expect(errorCode(() => service.update({ memoryId: 'mem-1', content: '   ' }))).toBe(
      'storage.invalid_record',
    )
  })

  it('删除会话范围的条目，并把事件记进那个会话', () => {
    const { service, storage, published } = seed()
    service.remember({
      sessionId: 's1',
      runId: 'r1',
      agent,
      scope: 'session',
      content: '会话约定',
    })
    published.length = 0
    expect(service.remove({ memoryId: 'mem-2' })).toEqual({})
    expect(storage.memories.get('mem-2')).toBeUndefined()
    expect(published).toEqual([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 456,
        type: 'memory.deleted',
        payload: { memoryId: 'mem-2', scope: 'session' },
      },
    ])
  })

  it('从某个会话删除项目条目时按给出的会话记事件', () => {
    const { service, published } = seed()
    published.length = 0
    service.remove({ memoryId: 'mem-1', sessionId: 's1' })
    expect(published[0]).toMatchObject({
      sessionId: 's1',
      type: 'memory.deleted',
      payload: { memoryId: 'mem-1', scope: 'project' },
    })
  })

  it('没有会话上下文时，项目与全局条目只改存储', () => {
    const { service, published } = seed()
    published.length = 0
    service.remove({ memoryId: 'g1' })
    service.remove({ memoryId: 'mem-1' })
    expect(published).toEqual([])
  })

  it('删除不存在的条目时报 memory.not_found', () => {
    const { service } = seed()
    expect(errorCode(() => service.remove({ memoryId: 'missing' }))).toBe(MemoryErrorCode.NotFound)
  })
})
