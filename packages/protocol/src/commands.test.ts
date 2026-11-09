import { describe, expect, it } from 'vitest'
import { BackgroundCommand, BackgroundCommandOutput } from './commands.js'
import { MainForHost } from './contracts/host-main.js'
import { MainForRenderer } from './contracts/renderer-main.js'

const command = {
  commandId: 'cmd1',
  sessionId: 's1',
  runId: 'r1',
  command: 'npm run dev',
  cwd: '/work',
  startedAt: 1,
  status: 'running' as const,
}

describe('background command contracts', () => {
  it('validates commands and bounded output', () => {
    expect(BackgroundCommand.parse(command)).toEqual(command)
    expect(
      BackgroundCommandOutput.parse({
        command,
        chunks: [{ stream: 'stderr', text: 'oops' }],
        omittedChars: 0,
      }).chunks,
    ).toHaveLength(1)
    expect(BackgroundCommand.safeParse({ ...command, command: '' }).success).toBe(false)
    expect(
      BackgroundCommandOutput.safeParse({
        command,
        chunks: [{ stream: 'stdin', text: 'x' }],
        omittedChars: 0,
      }).success,
    ).toBe(false)
  })

  it('exposes command RPCs and the host start request', () => {
    const requests = MainForRenderer.requests
    expect(requests['command.list'].params.parse({})).toEqual({})
    expect(requests['command.output'].params.parse({ commandId: 'cmd1' })).toEqual({
      commandId: 'cmd1',
    })
    expect(requests['command.stop'].params.parse({ commandId: 'cmd1' })).toEqual({
      commandId: 'cmd1',
    })
    expect(
      MainForHost.requests['host.command.start'].params.parse({
        runId: 'r1',
        command: 'npm run dev',
        cwd: '/work',
        timeoutSeconds: 60,
      }),
    ).toMatchObject({ runId: 'r1', timeoutSeconds: 60 })
    expect(
      MainForHost.requests['host.command.start'].params.safeParse({
        runId: 'r1',
        command: 'x',
        cwd: '/work',
        timeoutSeconds: 0,
      }).success,
    ).toBe(false)
  })

  it('rejects empty project and skill patches', () => {
    const requests = MainForRenderer.requests
    expect(requests['project.update'].params.safeParse({ projectId: 'p1' }).success).toBe(false)
    expect(
      requests['project.update'].params.safeParse({
        projectId: 'p1',
        enableProjectSkills: true,
      }).success,
    ).toBe(true)
    expect(
      requests['project.update'].params.safeParse({ projectId: 'p1', pinned: true }).success,
    ).toBe(true)
    expect(
      requests['project.update'].params.safeParse({ projectId: 'p1', archived: false }).success,
    ).toBe(true)
    expect(requests['skill.get'].params.safeParse({ name: 'x', source: 'project' }).success).toBe(
      false,
    )
    expect(
      requests['skill.get'].params.safeParse({
        name: 'x',
        source: 'project',
        projectId: 'p1',
      }).success,
    ).toBe(true)
    expect(
      requests['skill.setEnabled'].params.safeParse({
        name: 'x',
        source: 'project',
        projectId: 'p1',
      }).success,
    ).toBe(false)
    expect(
      requests['skill.setEnabled'].params.safeParse({
        name: 'x',
        source: 'project',
        projectId: 'p1',
        pinned: true,
      }).success,
    ).toBe(true)
  })
})
