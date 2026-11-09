import { ToolError, type ToolDefinition } from '@cairn/core'
import type { BackgroundCommand, SandboxExecution } from '@cairn/protocol'
import type { SandboxPolicy } from '@cairn/shell'
import { resolveOrThrow } from './paths.js'

export interface StartCommandInput {
  readonly command: string
  readonly cwd?: string
  readonly timeoutSeconds?: number
}

export const START_COMMAND_MAX_TIMEOUT_SECONDS = 86_400

export function createStartCommandTool(options: {
  readonly start: (input: {
    readonly command: string
    readonly cwd: string
    readonly timeoutSeconds?: number
    /** 这次后台命令的沙箱策略（M5-04）；主进程按它决定执行机制。 */
    readonly sandbox?: SandboxPolicy
  }) => Promise<BackgroundCommand>
  /** 由宿主解析的沙箱策略，传给主进程；省略时按现有语义执行。 */
  readonly sandbox?: SandboxPolicy
  /** `tool.started` 中显示的沙箱（能力与策略已解析）；省略时不显示。 */
  readonly execution?: SandboxExecution
}): ToolDefinition<StartCommandInput> {
  return {
    name: 'start_command',
    description:
      'Start a long-running command in the background and return immediately. Use this for development servers, ' +
      'watchers and other processes that do not exit. The process tree is stopped when the app exits or when the ' +
      'user stops it; stdin is closed. Use run_command for commands that finish on their own.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', pattern: '\\S', description: 'The command to run.' },
        cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: START_COMMAND_MAX_TIMEOUT_SECONDS,
          description: 'Optional safety timeout; the command is stopped when it expires.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    category: 'execute',
    source: { kind: 'builtin' },
    trust: 'builtin',
    ...(options.execution ? { sandbox: options.execution } : {}),
    normalize: async (input, ctx) => {
      if (input.cwd !== undefined) await resolveOrThrow(ctx, input.cwd)
      return { input, targets: { command: input.command } }
    },
    async describeForApproval(input, ctx) {
      const cwd =
        input.cwd === undefined
          ? ctx.workspaceRoot
          : (await resolveOrThrow(ctx, input.cwd)).absolute
      return {
        summary: `Start a background command in ${cwd}; it keeps running until stopped or the app exits`,
        command: input.command,
      }
    },
    async execute(input, ctx) {
      const cwd =
        input.cwd === undefined
          ? ctx.workspaceRoot
          : (await resolveOrThrow(ctx, input.cwd)).absolute
      try {
        const command = await options.start({
          command: input.command,
          cwd,
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
        })
        return {
          content: [
            {
              type: 'text',
              text: `Started background command ${command.commandId} in ${cwd}. It keeps running after this tool returns.`,
            },
          ],
        }
      } catch (error) {
        throw new ToolError(
          'command.start_failed',
          `Cannot start the background command: ${(error as Error).message}`,
        )
      }
    },
  }
}
