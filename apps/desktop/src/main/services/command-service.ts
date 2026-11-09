import { randomUUID } from 'node:crypto'
import type { BackgroundCommand, BackgroundCommandOutput, UnsequencedEvent } from '@cairn/protocol'
import { runCommand, selectShell, type ShellInfo, type ShellPreference } from '@cairn/shell'
import { OutputChunkBuffer } from '@cairn/tools'
import type { Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'

const MAX_RUNNING = 8
const MAX_OUTPUT = 100_000
const DEFAULT_TIMEOUT_SECONDS = 3_600

export interface CommandServiceOptions {
  readonly storage: Storage
  readonly events: Pick<SessionEventService, 'publish'>
  readonly shell: () => ShellPreference
  readonly isAllowedCwd?: (sessionId: string, cwd: string) => boolean | Promise<boolean>
  readonly select?: (preference: ShellPreference) => Promise<ShellInfo>
  readonly execute?: typeof runCommand
  readonly now?: () => number
  readonly id?: () => string
  readonly onError?: (error: unknown) => void
}

export function createCommandService(options: CommandServiceOptions) {
  const active = new Map<
    string,
    { abort: AbortController; done: Promise<void>; output: OutputChunkBuffer }
  >()
  const listeners = new Set<(commandId: string) => void>()
  const now = options.now ?? Date.now
  let closing = false
  for (const command of options.storage.commands.list()) {
    if (command.status === 'running' || command.status === 'stopping') {
      options.storage.commands.finish(command.commandId, 'interrupted', null, now())
    }
  }

  const changed = (commandId: string) => {
    for (const listener of listeners) listener(commandId)
  }
  const publish = (
    record: BackgroundCommand,
    event: UnsequencedEvent['type'],
    payload: UnsequencedEvent['payload'],
  ) => {
    options.events.publish([
      {
        v: 1,
        sessionId: record.sessionId,
        runId: record.runId,
        ts: now(),
        type: event,
        payload,
      } as UnsequencedEvent,
    ])
  }
  const stop = ({ commandId }: { commandId: string }): BackgroundCommand => {
    const running = active.get(commandId)
    const command = options.storage.commands.get(commandId)
    if (!command) throw new Error(`Unknown command: ${commandId}`)
    if (running && command.status === 'running') {
      const stopping = options.storage.commands.finish(commandId, 'stopping', null, now())
      running.abort.abort()
      changed(commandId)
      return stopping
    }
    return command
  }

  return {
    list: () => ({ commands: options.storage.commands.list() }),
    output({ commandId }: { commandId: string }): BackgroundCommandOutput {
      const command = options.storage.commands.get(commandId)
      if (!command) throw new Error(`Unknown command: ${commandId}`)
      const buffer = active.get(commandId)?.output
      return buffer
        ? { command, ...buffer.display() }
        : (options.storage.commands.output(commandId) ?? { command, chunks: [], omittedChars: 0 })
    },
    subscribe(listener: (commandId: string) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async start(input: {
      sessionId: string
      runId: string
      command: string
      cwd: string
      timeoutSeconds?: number
    }): Promise<BackgroundCommand> {
      if (closing || active.size >= MAX_RUNNING)
        throw new Error('Background command capacity reached')
      const session = options.storage.sessions.get(input.sessionId)
      if (!session) {
        throw new Error('Invalid command workspace')
      }
      const allowed = options.isAllowedCwd
        ? await options.isAllowedCwd(input.sessionId, input.cwd)
        : input.cwd === session.workspacePath
      if (!allowed) throw new Error('Invalid command workspace')
      const shell = await (options.select ?? ((preference) => selectShell({ preference })))(
        options.shell(),
      )
      if (closing || active.size >= MAX_RUNNING)
        throw new Error('Background command service is closing or full')
      const command: BackgroundCommand = {
        commandId: (options.id ?? randomUUID)(),
        sessionId: input.sessionId,
        runId: input.runId,
        command: input.command,
        cwd: input.cwd,
        startedAt: now(),
        status: 'running',
      }
      options.storage.commands.create(command)
      const abort = new AbortController()
      const output = new OutputChunkBuffer(MAX_OUTPUT)
      const write = (stream: 'stdout' | 'stderr') => (text: string) => {
        output.push(stream, text)
        try {
          publish(command, 'command.output.delta', { commandId: command.commandId, stream, text })
        } catch (error) {
          options.onError?.(error)
        }
        changed(command.commandId)
      }
      const done = (options.execute ?? runCommand)(shell, input.command, {
        cwd: input.cwd,
        signal: abort.signal,
        timeoutMs: (input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000,
        collectOutput: false,
        onStdout: write('stdout'),
        onStderr: write('stderr'),
      })
        .then((result) => {
          const status = result.timedOut ? 'timed_out' : result.aborted ? 'stopped' : 'exited'
          const finished = options.storage.commands.finish(
            command.commandId,
            status,
            result.exitCode,
            now(),
          )
          options.storage.commands.saveOutput(command.commandId, {
            command: finished,
            ...output.display(),
          })
          publish(
            command,
            status === 'stopped' ? 'command.stopped' : 'command.exited',
            status === 'stopped'
              ? { commandId: command.commandId }
              : { commandId: command.commandId, status, exitCode: result.exitCode },
          )
        })
        .catch((error: unknown) => {
          const finished = options.storage.commands.finish(command.commandId, 'failed', null, now())
          options.storage.commands.saveOutput(command.commandId, {
            command: finished,
            ...output.display(),
          })
          publish(command, 'command.exited', {
            commandId: command.commandId,
            status: 'failed',
            exitCode: null,
          })
          options.onError?.(error)
        })
        .finally(() => {
          active.delete(command.commandId)
          changed(command.commandId)
        })
      active.set(command.commandId, { abort, done, output })
      try {
        publish(command, 'command.started', {
          commandId: command.commandId,
          command: command.command,
          cwd: command.cwd,
        })
      } catch (error) {
        options.onError?.(error)
      }
      changed(command.commandId)
      return command
    },
    stop,
    async shutdown(): Promise<void> {
      closing = true
      const running = [...active.values()]
      for (const item of running) item.abort.abort()
      await Promise.all(running.map((item) => item.done))
    },
    async stopRun(runId: string): Promise<void> {
      const items = [...active.entries()].filter(
        ([id]) => options.storage.commands.get(id)?.runId === runId,
      )
      for (const [id] of items) stop({ commandId: id })
      await Promise.all(items.map(([, item]) => item.done))
    },
  }
}
