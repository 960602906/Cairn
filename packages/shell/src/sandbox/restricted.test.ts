import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JobObject } from '../job-object.js'
import type { ContainerAcl } from './appcontainer.js'
import type { IntegrityController } from './integrity.js'
import { createSandboxRunner } from './restricted.js'
import { SandboxError, type SandboxAbortSignal, type SandboxPolicy } from './types.js'
import type { NativeSpawnOptions, SandboxNativeApi } from './windows-api.js'

interface Harness {
  readonly root: string
  readonly workspace: string
  readonly api: SandboxNativeApi
  readonly state: {
    files: Map<bigint, string>
    closed: bigint[]
    resumed: bigint[]
    spawns: NativeSpawnOptions[]
    terminated: bigint[]
    polls: number
    exitCode: number
    exited: boolean
    exitAfter: number | undefined
    output: { stdout?: Buffer[]; stderr?: Buffer[] }
    deleted: string[]
  }
}

function harness(
  options: {
    exited?: boolean
    exitAfter?: number
    exitCode?: number
    output?: { stdout?: Buffer[]; stderr?: Buffer[] }
    spawnThrows?: unknown
    tokenThrows?: boolean
    appContainerName?: string
  } = {},
): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'cairn-sandbox-test-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  const state: Harness['state'] = {
    files: new Map(),
    closed: [],
    resumed: [],
    spawns: [],
    terminated: [],
    polls: 0,
    exitCode: options.exitCode ?? 0,
    exited: options.exited ?? true,
    exitAfter: options.exitAfter,
    output: options.output ?? {},
    deleted: [],
  }
  let next = 10n
  const api: SandboxNativeApi = {
    currentUserSid: () => 'S-1-5-21-1',
    createRestrictedToken: () => {
      if (options.tokenThrows) throw new SandboxError('sandbox.setup_failed', 'token')
      return 1n
    },
    openInheritableFile(file) {
      const handle = next++
      state.files.set(handle, file)
      return handle
    },
    openNul: () => 2n,
    closeHandle: (handle) => state.closed.push(handle),
    resumeThread: (thread) => state.resumed.push(thread),
    spawn(input) {
      if (options.spawnThrows) throw options.spawnThrows
      state.spawns.push(input)
      return { pid: 123, process: 3n, thread: 4n }
    },
    hasExited() {
      state.polls += 1
      // 每次检查前写出下一段（覆盖分片的 UTF-8）
      const stdout = state.output.stdout ?? []
      const stderr = state.output.stderr ?? []
      const fileFor = (index: number) => state.files.get(10n + BigInt(index))
      const chunk = state.polls - 1
      if (stdout[chunk]) {
        fs.appendFileSync(fileFor(0)!, stdout[chunk]!)
      }
      if (stderr[chunk]) {
        fs.appendFileSync(fileFor(1)!, stderr[chunk]!)
      }
      return state.exitAfter === undefined ? state.exited : state.polls >= state.exitAfter
    },
    exitCode: () => state.exitCode,
    terminate: (handle) => state.terminated.push(handle),
    appContainer: () => ({ sid: 5n, sidString: 'S-1-15-2-1' }),
    deriveAppContainer: () => 5n,
    deleteAppContainer: (name) => state.deleted.push(name),
    sidFromString: () => 6n,
    sidToString: () => 'S-1-15-2-1',
  }
  return { root, workspace, api, state }
}

function fakeJob(assign = true) {
  const state = { assigned: [] as number[], terminated: 0, closed: 0 }
  const job: JobObject = {
    assign(pid) {
      state.assigned.push(pid)
      return assign
    },
    terminate() {
      state.terminated += 1
      return true
    },
    close() {
      state.closed += 1
    },
  }
  return { job, state }
}

function integrity() {
  const calls: { directory: string; level: 'low' | 'medium' }[] = []
  const controller: IntegrityController = {
    setLevel: async (directory, level) => {
      calls.push({ directory, level })
    },
  }
  return { controller, calls }
}

function acl() {
  const grants: { directory: string; sid: string; access: string }[] = []
  const controller: ContainerAcl = {
    grant: async (directory, sid, access) => {
      grants.push({ directory, sid, access })
    },
    revoke: async () => undefined,
  }
  return { controller, grants }
}

const policy = (profile: SandboxPolicy['profile'], network: SandboxPolicy['network'] = 'none') => ({
  profile,
  network,
})

const availableCapability = {
  available: true,
  supported: true,
  mechanism: 'restricted-token',
  networkIsolated: false,
  checks: {
    restrictedToken: true,
    lowIntegrity: true,
    jobObject: true,
    appContainer: false,
  },
} as const

const invocation = {
  file: 'C:\\Windows\\System32\\cmd.exe',
  args: ['/d', '/c', 'echo hi'],
  env: { CAIRN_SHELL_COMMAND: 'echo hi' },
}

const run = (
  test: Harness,
  options: {
    profile?: SandboxPolicy['profile']
    network?: SandboxPolicy['network']
    mechanism?: 'restricted-token' | 'appcontainer'
    appContainerName?: string
    capability?: Awaited<ReturnType<typeof createSandboxRunner>>['capability']
    timeoutMs?: number
    signal?: SandboxAbortSignal
    job?: ReturnType<typeof fakeJob>
    terminateGraceMs?: number
    onStdout?: (text: string) => void
    onStderr?: (text: string) => void
  } = {},
) =>
  createSandboxRunner({
    platform: 'win32',
    api: test.api,
    integrity: integrity().controller,
    acl: acl().controller,
    jobFactory: async () => (options.job ?? fakeJob()).job,
    tempRoot: test.root,
    pollIntervalMs: 1,
    ...(options.terminateGraceMs ? { terminateGraceMs: options.terminateGraceMs } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
    mechanism: options.mechanism ?? 'restricted-token',
    ...(options.appContainerName ? { appContainer: { name: options.appContainerName } } : {}),
  }).then((runner) =>
    runner.run(policy(options.profile ?? 'workspace-write', options.network ?? 'none'), {
      invocation,
      cwd: test.workspace,
      env: { FOO: 'bar', PATH: 'C:\\bin' },
      timeoutMs: options.timeoutMs ?? 5_000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStdout ? { onStdout: options.onStdout } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    }),
  )

describe('createSandboxRunner', () => {
  it('runs a workspace-write command and streams split UTF-8 output', async () => {
    const test = harness({
      exitCode: 7,
      exitAfter: 4,
      output: {
        stdout: [Buffer.from('hel'), Buffer.from([0xe4]), Buffer.from([0xb8, 0xad, 0x21])],
        stderr: [Buffer.from('err')],
      },
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const result = await run(test, {
      network: 'internet',
      onStdout: (text) => stdout.push(text),
      onStderr: (text) => stderr.push(text),
    })
    expect(result).toMatchObject({
      exitCode: 7,
      aborted: false,
      timedOut: false,
      execution: {
        profile: 'workspace-write',
        network: 'internet',
        mechanism: 'restricted-token',
        enforced: true,
        networkIsolated: false,
      },
    })
    expect(stdout.join('')).toBe('hel中!')
    expect(stderr.join('')).toBe('err')
    const spawn = test.state.spawns[0]!
    expect(spawn.commandLine).toContain('cmd.exe')
    expect(spawn.env.toString('utf16le')).toContain('FOO=bar')
    expect(test.state.resumed).toEqual([4n])
    expect(test.state.closed).toContain(3n)
    expect(fs.readdirSync(test.root)).toEqual(['workspace'])
  })

  it('labels the workspace low for write and medium for read-only', async () => {
    const write = harness()
    const writeIntegrity = integrity()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: write.api,
      integrity: writeIntegrity.controller,
      acl: acl().controller,
      jobFactory: async () => fakeJob().job,
      tempRoot: write.root,
      pollIntervalMs: 1,
    })
    await runner.run(policy('workspace-write'), {
      invocation,
      cwd: write.workspace,
      env: {},
      timeoutMs: 1_000,
    })
    expect(writeIntegrity.calls.at(-1)).toEqual({
      directory: write.workspace,
      level: 'low',
    })
    const read = harness()
    const readIntegrity = integrity()
    const readRunner = await createSandboxRunner({
      platform: 'win32',
      api: read.api,
      integrity: readIntegrity.controller,
      acl: acl().controller,
      jobFactory: async () => fakeJob().job,
      tempRoot: read.root,
      pollIntervalMs: 1,
    })
    await readRunner.run(policy('read-only'), {
      invocation,
      cwd: read.workspace,
      env: {},
      timeoutMs: 1_000,
    })
    expect(readIntegrity.calls.at(-1)).toEqual({
      directory: read.workspace,
      level: 'medium',
    })
  })

  it('times out and terminates the process tree', async () => {
    const test = harness({ exited: false })
    const job = fakeJob()
    const result = await run(test, { timeoutMs: 20, terminateGraceMs: 50, job })
    expect(result).toMatchObject({ timedOut: true, aborted: false, exitCode: null })
    expect(job.state.terminated).toBeGreaterThan(0)
  })

  it('runs without a deadline when the timeout is zero', async () => {
    const test = harness({ exitAfter: 2 })
    const result = await run(test, { timeoutMs: 0 })
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
  })

  it('aborts before starting without creating a sandbox', async () => {
    const test = harness()
    const controller = new AbortController()
    controller.abort()
    const result = await run(test, { signal: controller.signal })
    expect(result).toMatchObject({ aborted: true, timedOut: false, durationMs: 0 })
    expect(result.execution.mechanism).toBe('restricted-token')
    expect(test.state.spawns).toHaveLength(0)
  })

  it('aborts a running command', async () => {
    const test = harness({ exited: false })
    const controller = new AbortController()
    const job = fakeJob()
    setTimeout(() => controller.abort(), 10)
    const result = await run(test, {
      signal: controller.signal,
      terminateGraceMs: 60,
      job,
    })
    expect(result.aborted).toBe(true)
    expect(job.state.terminated).toBeGreaterThan(0)
  })

  it('terminates the process when the signal aborts before it resumes', async () => {
    const test = harness()
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        return reads >= 2
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    const job = fakeJob()
    const result = await run(test, { signal, job })
    expect(result.aborted).toBe(true)
    expect(test.state.resumed).toEqual([])
    expect(test.state.terminated).toContain(3n)
    expect(job.state.terminated).toBeGreaterThan(0)
  })

  it('flushes an incomplete UTF-8 sequence at the end', async () => {
    const test = harness({ output: { stdout: [Buffer.from([0xe4, 0xb8])] } })
    const stdout: string[] = []
    const result = await run(test, { onStdout: (text) => stdout.push(text) })
    expect(result).toMatchObject({ exitCode: 0 })
    expect(stdout.join('')).toBe('\uFFFD')
  })

  it('fails closed when the job object is missing or cannot take the process', async () => {
    const missing = harness()
    const missingRunner = await createSandboxRunner({
      platform: 'win32',
      api: missing.api,
      integrity: integrity().controller,
      acl: acl().controller,
      jobFactory: async () => undefined,
      tempRoot: missing.root,
      pollIntervalMs: 1,
      capability: availableCapability,
    })
    const error = await missingRunner
      .run(policy('workspace-write'), {
        invocation,
        cwd: missing.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'sandbox.setup_failed' })

    const reject = harness()
    const rejected = fakeJob(false)
    const rejectRunner = await createSandboxRunner({
      platform: 'win32',
      api: reject.api,
      integrity: integrity().controller,
      acl: acl().controller,
      jobFactory: async () => rejected.job,
      tempRoot: reject.root,
      pollIntervalMs: 1,
      capability: availableCapability,
    })
    const assignError = await rejectRunner
      .run(policy('workspace-write'), {
        invocation,
        cwd: reject.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((e: unknown) => e)
    expect(assignError).toMatchObject({ code: 'sandbox.setup_failed' })
    expect(rejected.state.closed).toBe(1)
    expect(reject.state.terminated).toContain(3n)
  })

  it('fails closed when the AppContainer process cannot join the job', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      jobFactory: async () => undefined,
      tempRoot: test.root,
      mechanism: 'appcontainer',
      appContainer: { name: 'com.cairn.sandbox.test' },
      capability: {
        available: true,
        supported: true,
        mechanism: 'appcontainer',
        networkIsolated: true,
        checks: {
          restrictedToken: true,
          lowIntegrity: true,
          jobObject: true,
          appContainer: true,
        },
      },
    })
    const error = await runner
      .run(policy('workspace-write'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'sandbox.setup_failed' })
  })

  it('propagates spawn and token failures', async () => {
    const spawnFailure = harness({
      spawnThrows: new SandboxError('sandbox.spawn_failed', 'no process'),
    })
    const error = await run(spawnFailure, { capability: availableCapability }).catch(
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'sandbox.spawn_failed' })
    expect(spawnFailure.state.closed).toContain(1n)

    const tokenFailure = harness({ tokenThrows: true })
    const tokenError = await run(tokenFailure, { capability: availableCapability }).catch(
      (e: unknown) => e,
    )
    expect(tokenError).toMatchObject({ code: 'sandbox.setup_failed' })
  })

  it('rejects danger-full-access and unavailable sandboxes', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      integrity: integrity().controller,
      acl: acl().controller,
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
    })
    const danger = await runner
      .run(policy('danger-full-access'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((e: unknown) => e)
    expect(danger).toMatchObject({ code: 'sandbox.unavailable' })
    const unsupported = await createSandboxRunner({
      platform: 'linux',
      api: null,
      tempRoot: test.root,
    })
    const unavailable = await unsupported
      .run(policy('workspace-write'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((e: unknown) => e)
    expect(unavailable).toMatchObject({ code: 'sandbox.unavailable' })
    expect(unsupported.executionFor(policy('workspace-write')).reason).toBe(
      'sandbox.platform_unsupported',
    )
  })

  it('fails closed with a generic reason when the capability is unavailable', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
      capability: {
        available: false,
        supported: true,
        mechanism: 'none',
        networkIsolated: false,
        checks: {
          restrictedToken: false,
          lowIntegrity: false,
          jobObject: true,
          appContainer: false,
        },
      },
    })
    expect(runner.executionFor(policy('workspace-write')).reason).toBe('sandbox.unavailable')
    const error = await runner
      .run(policy('workspace-write'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'sandbox.unavailable',
      params: { reason: 'sandbox.unavailable' },
    })
  })

  it('names the native API when it is missing and the capability has no reason', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: null,
      tempRoot: test.root,
      capability: {
        available: false,
        supported: true,
        mechanism: 'none',
        networkIsolated: false,
        checks: {
          restrictedToken: false,
          lowIntegrity: false,
          jobObject: false,
          appContainer: false,
        },
      },
    })
    const error = await runner
      .run(policy('workspace-write'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'sandbox.unavailable',
      params: { reason: 'sandbox.native_unavailable' },
    })
  })

  it('builds the real controllers with the given environment', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      env: { SystemRoot: 'D:\\Win' },
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
      capability: availableCapability,
    })
    expect(runner.capability).toEqual(availableCapability)
  })

  it('defaults the platform to the current process', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      api: test.api,
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
      capability: availableCapability,
    })
    expect(runner.capability).toEqual(availableCapability)
  })

  it('cleans up when integrity setup fails, even with default temp root and job factory', async () => {
    const test = harness()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      integrity: {
        setLevel: async () => {
          throw new SandboxError('sandbox.setup_failed', 'icacls denied')
        },
      },
      acl: acl().controller,
      capability: availableCapability,
    })
    const error = await runner
      .run(policy('workspace-write'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'sandbox.setup_failed' })
  })

  it('grants AppContainer access and network capabilities', async () => {
    const test = harness()
    const aclState = acl()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      integrity: integrity().controller,
      acl: aclState.controller,
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
      pollIntervalMs: 1,
      mechanism: 'appcontainer',
      appContainer: { name: 'com.cairn.sandbox.test' },
    })
    await runner.run(policy('workspace-write', 'internet'), {
      invocation,
      cwd: test.workspace,
      env: {},
      timeoutMs: 1_000,
    })
    expect(aclState.grants[0]).toMatchObject({
      directory: test.workspace,
      access: 'modify',
    })
    expect(test.state.spawns[0]!.appContainer).toEqual({
      sid: 5n,
      capabilitySids: ['S-1-15-3-1'],
    })
    const missing = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      integrity: integrity().controller,
      acl: aclState.controller,
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
      mechanism: 'appcontainer',
    })
    const error = await missing
      .run(policy('workspace-write'), {
        invocation,
        cwd: test.workspace,
        env: {},
        timeoutMs: 1_000,
      })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'sandbox.setup_failed' })
  })

  it('grants read-only AppContainer access without network capabilities', async () => {
    const test = harness()
    const aclState = acl()
    const runner = await createSandboxRunner({
      platform: 'win32',
      api: test.api,
      integrity: integrity().controller,
      acl: aclState.controller,
      jobFactory: async () => fakeJob().job,
      tempRoot: test.root,
      pollIntervalMs: 1,
      mechanism: 'appcontainer',
      appContainer: { name: 'com.cairn.sandbox.test' },
    })
    await runner.run(policy('read-only', 'none'), {
      invocation,
      cwd: test.workspace,
      env: {},
      timeoutMs: 1_000,
    })
    expect(aclState.grants).toEqual([
      { directory: test.workspace, sid: 'S-1-15-2-1', access: 'read' },
      { directory: expect.stringContaining('cairn-sandbox-'), sid: 'S-1-15-2-1', access: 'modify' },
    ])
    expect(test.state.spawns[0]!.appContainer).toEqual({ sid: 5n, capabilitySids: [] })
  })
})
