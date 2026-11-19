/**
 * 普通会话的自动修复入口：`watch_pull_request`。
 *
 * 用户让 Agent 提交代码并创建 PR 之后，Agent 先用 `ask_user` 问一句“要开启自动修复吗”，得到同意再调用
 * 这个工具。工具只做代理：真正建立监视在主进程，那里有 GitHub 令牌、会话的项目目录与监视上限，
 * 并再次校验 PR 可读。监视之后由主进程轮询，CI 失败、合并冲突或新评审意见时在独立工作区开修复会话。
 *
 * 自动修复会话自身不注册这个工具，避免修复会话再开监视。
 */
import { ToolError, type ToolRegistry } from '@cairn/core'
import { RpcError } from '@cairn/protocol'

export const WATCH_PULL_REQUEST_TOOL = 'watch_pull_request'

/** 主进程建立监视；由宿主注入，测试里用假实现。 */
export interface PullRequestWatchTools {
  watch(input: {
    repo: string
    prNumber: number
    triggers?: ('ci' | 'conflict' | 'comment')[]
  }): Promise<{ repo: string; prNumber: number }>
}

/** 错误码对应的默认说明；主进程给出 `reason` 时优先用它。 */
const MESSAGES: Readonly<Record<string, string>> = {
  'autofix.duplicate': 'This pull request is already watched; nothing more to do.',
  'autofix.too_many':
    'Too many pull requests are watched already. Ask the user to remove one first.',
  'github.not_connected':
    'No GitHub token is available, so the pull request cannot be watched. Ask the user to run gh auth login or set GH_TOKEN.',
  'github.not_found': 'The pull request was not found. Check the repository and number.',
  'github.auth_failed':
    'The GitHub token from the environment or gh CLI was rejected. Ask the user to check it.',
  'autofix.not_auto_fix': 'This session cannot start a pull request watch.',
}

function toToolError(error: unknown): ToolError {
  if (error instanceof RpcError) {
    const reason = error.params?.['reason']
    const text = typeof reason === 'string' ? reason : (MESSAGES[error.code] ?? error.code)
    return new ToolError(error.code, text)
  }
  return new ToolError(
    'tool.execution_failed',
    error instanceof Error ? error.message : String(error),
  )
}

export function registerPullRequestWatchTool(
  registry: ToolRegistry,
  tools: PullRequestWatchTools,
): void {
  registry.register({
    name: WATCH_PULL_REQUEST_TOOL,
    description:
      'Watch a pull request that already exists so that failing checks, merge conflicts or new review comments are repaired automatically in a separate worktree. Only call this after asking the user whether to enable auto-fix for that pull request and getting a yes. The user also approves this call.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository as owner/name, for example "acme/app".',
          minLength: 3,
          maxLength: 200,
        },
        prNumber: {
          type: 'integer',
          description: 'Pull request number.',
          minimum: 1,
        },
        comment: {
          type: 'boolean',
          description: 'Also repair when new review comments appear. Defaults to false.',
        },
      },
      required: ['repo', 'prNumber'],
      additionalProperties: false,
    },
    category: 'network',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const { repo, prNumber, comment } = input as {
        repo: string
        prNumber: number
        comment?: boolean
      }
      try {
        const watch = await tools.watch({
          repo,
          prNumber,
          triggers: comment === true ? ['ci', 'conflict', 'comment'] : ['ci', 'conflict'],
        })
        return {
          content: [
            {
              type: 'text',
              text: `Watching ${watch.repo}#${watch.prNumber}: failing checks and merge conflicts will be repaired automatically.`,
            },
          ],
        }
      } catch (error) {
        throw toToolError(error)
      }
    },
  })
}
