import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { BackgroundCommandOutput, EventEnvelope, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import type { RunCommandOptions, RunCommandResult } from '@cairn/shell'
import { createCommandService } from './command-service.js'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-command-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const result = (overrides: Partial<RunCommandResult> = {}): RunCommandResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  aborted: false,
  timedOut: false,
  durationMs: 5,
  ...overrides,
})

function setup(
  options: {
    execute?: (
      shell: unknown,
      command: string,
      opts: RunCommandOptions,
    ) => Promise<RunCommandResult>
    allowed?: boolean
    now?: () => number
    publishError?: boolean
  } = {},
) {
  const storage = createMemoryStorage({ now: () => 10 })
  storage.projects.create({ projectId: 'p1', name: 'P', path: '/work' })
  storage.sessions.create({ sessionId: 's1', projectId: 'p1', workspacePath: '/work', title: 'S' })
  const publish = vi.fn((events: readonly UnsequencedEvent[]) => {
    if (options.publishError) throw new Error('listener failed')
    return events as unknown as EventEnvelope[]
  })
  const onError = vi.fn()
  let nextId = 0
  const service = createCommandService({
    storage,
    events: { publish },
    shell: () => 'auto',
    select: async () => ({ kind: 'bash', exe: '/bin/bash' }),
    ...(options.execute ? { execute: options.execute } : {}),
    ...(options.allowed === undefined ? {} : { isAllowedCwd: () => options.allowed! }),
    now: options.now ?? (() => 10),
    id: () => `cmd${++nextId}`,
    onError,
  })
  return { storage, publish, onError, service }
}

const start = (service: ReturnType<typeof setup>['service'], cwd = '/work') =>
  service.start({ sessionId: 's1', runId: 'r1', command: 'echo ok', cwd })

describe('command service', () => {
  it('streams, persists bounded output and reports the exit code', async () => {
    let options!: RunCommandOptions
    let finish!: (value: RunCommandResult) => void
    const { storage, publish, service } = setup({
      execute: (_shell, _command, opts) => {
        options = opts
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const command = await start(service)
    expect(command.status).toBe('running')
    expect(service.list().commands).toEqual([command])
    options.onStdout?.('hello\n')
    options.onStderr?.('oops\n')
    expect(service.output({ commandId: 'cmd1' }).chunks).toEqual([
      { stream: 'stdout', text: 'hello\n' },
      { stream: 'stderr', text: 'oops\n' },
    ])
    finish(result({ exitCode: 3 }))
    await vi.waitFor(() => expect(storage.commands.get('cmd1')?.status).toBe('exited'))
    expect(storage.commands.get('cmd1')).toMatchObject({ exitCode: 3, endedAt: 10 })
    expect(service.output({ commandId: 'cmd1' }).chunks).toHaveLength(2)
    expect(publish.mock.calls.map(([events]) => events[0]!.type)).toEqual([
      'command.started',
      'command.output.delta',
      'command.output.delta',
      'command.exited',
    ])
    expect(service.stop({ commandId: 'cmd1' }).status).toBe('exited')
    expect(() => service.output({ commandId: 'missing' })).toThrow('Unknown command')
    expect(() => service.stop({ commandId: 'missing' })).toThrow('Unknown command')
  })

  it('stops a running command and waits for its process tree', async () => {
    let options!: RunCommandOptions
    const { storage, service } = setup({
      execute: (_shell, _command, opts) => {
        options = opts
        return new Promise((resolve) =>
          opts.signal!.addEventListener('abort', () =>
            resolve(result({ aborted: true, exitCode: null })),
          ),
        )
      },
    })
    await start(service)
    expect(service.stop({ commandId: 'cmd1' }).status).toBe('stopping')
    expect(options.signal!.aborted).toBe(true)
    await vi.waitFor(() => expect(storage.commands.get('cmd1')?.status).toBe('stopped'))
  })

  it('records timeouts and execution failures', async () => {
    const timeout = setup({ execute: async () => result({ timedOut: true, exitCode: null }) })
    await start(timeout.service)
    await vi.waitFor(() => expect(timeout.storage.commands.get('cmd1')?.status).toBe('timed_out'))

    const failure = setup({
      execute: async () => {
        throw new Error('spawn failed')
      },
    })
    await start(failure.service)
    await vi.waitFor(() => expect(failure.storage.commands.get('cmd1')?.status).toBe('failed'))
    expect(failure.onError).toHaveBeenCalledWith(new Error('spawn failed'))
  })

  it('validates the workspace, session and capacity', async () => {
    const { service } = setup({
      execute: (_shell, _command, opts) =>
        new Promise((resolve) =>
          opts.signal!.addEventListener('abort', () =>
            resolve(result({ aborted: true, exitCode: null })),
          ),
        ),
    })
    await expect(start(service, '/elsewhere')).rejects.toThrow('Invalid command workspace')
    await expect(
      service.start({ sessionId: 'missing', runId: 'r1', command: 'x', cwd: '/work' }),
    ).rejects.toThrow('Invalid command workspace')
    const denied = setup({
      allowed: false,
      execute: (_shell, _command, opts) =>
        new Promise((resolve) =>
          opts.signal!.addEventListener('abort', () =>
            resolve(result({ aborted: true, exitCode: null })),
          ),
        ),
    })
    await expect(start(denied.service)).rejects.toThrow('Invalid command workspace')
    for (let i = 0; i < 8; i++) await start(service)
    await expect(start(service)).rejects.toThrow('capacity')
    await service.shutdown()
  })

  it('stops commands by run and rejects starts while shutting down', async () => {
    let options!: RunCommandOptions
    const { storage, service } = setup({
      execute: (_shell, _command, opts) => {
        options = opts
        return new Promise((resolve) =>
          opts.signal!.addEventListener('abort', () =>
            resolve(result({ aborted: true, exitCode: null })),
          ),
        )
      },
    })
    await start(service)
    await service.stopRun('r1')
    expect(options.signal!.aborted).toBe(true)
    expect(storage.commands.get('cmd1')?.status).toBe('stopped')
    await service.shutdown()
    await expect(start(service)).rejects.toThrow('capacity')
  })

  it('marks records left running by a crash as interrupted', () => {
    const next = setup()
    next.storage.commands.create({
      commandId: 'old',
      sessionId: 's1',
      runId: 'r1',
      command: 'server',
      cwd: '/work',
      startedAt: 1,
      status: 'stopping',
    })
    next.storage.commands.create({
      commandId: 'older',
      sessionId: 's1',
      runId: 'r1',
      command: 'server',
      cwd: '/work',
      startedAt: 0,
      status: 'running',
    })
    next.storage.commands.create({
      commandId: 'finished',
      sessionId: 's1',
      runId: 'r1',
      command: 'true',
      cwd: '/work',
      startedAt: 0,
      status: 'exited',
      exitCode: 0,
      endedAt: 1,
    })
    createCommandService({
      storage: next.storage,
      events: { publish: vi.fn() },
      shell: () => 'auto',
      select: async () => ({ kind: 'bash', exe: '/bin/bash' }),
      now: () => 50,
    })
    expect(next.storage.commands.get('old')).toMatchObject({ status: 'interrupted', endedAt: 50 })
    expect(next.storage.commands.get('older')).toMatchObject({ status: 'interrupted', endedAt: 50 })
    expect(next.storage.commands.get('finished')).toMatchObject({ status: 'exited' })
  })

  it('keeps output when an event listener fails', async () => {
    let options!: RunCommandOptions
    const { onError, service } = setup({
      publishError: true,
      execute: (_shell, _command, opts) => {
        options = opts
        return new Promise(() => {})
      },
    })
    await start(service)
    options.onStdout?.('still buffered')
    expect(onError).toHaveBeenCalled()
    expect(service.output({ commandId: 'cmd1' }).chunks[0]?.text).toBe('still buffered')
  })

  it('supports subscriptions and reads empty output for a finished record', () => {
    const { storage, service } = setup()
    const listener = vi.fn()
    const off = service.subscribe(listener)
    storage.commands.create({
      commandId: 'done',
      sessionId: 's1',
      runId: 'r1',
      command: 'true',
      cwd: '/work',
      startedAt: 1,
      status: 'exited',
      exitCode: 0,
      endedAt: 2,
    })
    expect(service.output({ commandId: 'done' })).toEqual({
      command: storage.commands.get('done'),
      chunks: [],
      omittedChars: 0,
    })
    off()
  })

  it('rejects a start that finishes selecting the shell while shutting down', async () => {
    let release!: (shell: { kind: 'bash'; exe: string }) => void
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p1', name: 'P', path: '/work' })
    storage.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: '/work',
      title: 'S',
    })
    const service = createCommandService({
      storage,
      events: { publish: vi.fn() },
      shell: () => 'auto',
      select: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    const starting = start(service)
    await service.shutdown()
    release({ kind: 'bash', exe: '/bin/bash' })
    await expect(starting).rejects.toThrow('closing or full')
  })

  it('starts a real command, streams output and stops the whole process tree', async () => {
    const work = tempDir()
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p1', name: 'P', path: work })
    storage.sessions.create({ sessionId: 's1', projectId: 'p1', workspacePath: work, title: 'S' })
    const service = createCommandService({
      storage,
      events: { publish: vi.fn() },
      shell: () => 'auto',
    })
    const pidFile = join(work, 'pid.txt')
    const script = `require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => console.log('tick'), 20)`
    await service.start({
      sessionId: 's1',
      runId: 'r1',
      command: `node -e "${script}" "${pidFile}"`,
      cwd: work,
    })
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
    await vi.waitFor(
      () => {
        const output = service.output({
          commandId: storage.commands.list()[0]!.commandId,
        }) as BackgroundCommandOutput
        expect(output.chunks.some((chunk) => chunk.text.includes('tick'))).toBe(true)
      },
      { timeout: 10_000 },
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const commandId = storage.commands.list()[0]!.commandId
    service.stop({ commandId })
    await vi.waitFor(() => expect(storage.commands.get(commandId)?.status).toBe('stopped'), {
      timeout: 10_000,
    })
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
  })
})
