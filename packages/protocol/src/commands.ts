import { z } from 'zod'
import { Id, Timestamp } from './common.js'

export const BackgroundCommandStatus = z.enum([
  'running',
  'stopping',
  'exited',
  'stopped',
  'timed_out',
  'failed',
  'interrupted',
])
export type BackgroundCommandStatus = z.infer<typeof BackgroundCommandStatus>

export const BackgroundCommand = z.object({
  commandId: Id,
  sessionId: Id,
  runId: Id,
  command: z.string().min(1),
  cwd: z.string().min(1),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  exitCode: z.number().int().nullable().optional(),
  status: BackgroundCommandStatus,
})
export type BackgroundCommand = z.infer<typeof BackgroundCommand>

export const CommandOutputChunk = z.object({
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
})
export const BackgroundCommandOutput = z.object({
  command: BackgroundCommand,
  chunks: z.array(CommandOutputChunk),
  omittedChars: z.number().int().nonnegative(),
  omittedAt: z.number().int().nonnegative().optional(),
})
export type BackgroundCommandOutput = z.infer<typeof BackgroundCommandOutput>
