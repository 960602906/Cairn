/**
 * 自动修复会话专用的 Git 工具（M8-03）：`git_commit` 与 `git_push`。
 *
 * - 只在实际为 `kind === 'auto-fix'` 的会话里注册（`host.init.autoFix` 存在），其他会话的模型
 *   看不到这两个工具；
 * - 工具本身只做代理：真正执行在主进程，那里有工作区、监视与 GitHub 令牌，并再次校验会话种类；
 * - 没有 `--force`、amend、切分支等参数：推送目标与守卫都由主进程按最新的 PR 快照决定；
 * - 失败原因会作为工具结果交给模型，模型可以据此调整，而不是让整轮失败。
 */
import { ToolError, type ToolRegistry } from '@cairn/core'
import { RpcError } from '@cairn/protocol'

export const GIT_COMMIT_TOOL = 'git_commit'
export const GIT_PUSH_TOOL = 'git_push'

/** 主进程执行提交 / 推送；由宿主注入，测试里用假实现。 */
export interface AutoFixGitTools {
  commit(input: { message: string }): Promise<{ sha: string }>
  push(): Promise<{ sha: string; branch: string }>
}

/** 错误码对应的默认说明；主进程给出 `reason` 时优先用它。 */
const MESSAGES: Readonly<Record<string, string>> = {
  'autofix.not_auto_fix':
    'This session is not an auto-fix session, so Git write tools are unavailable.',
  'autofix.commit_failed':
    'The commit failed. There may be no changes, or Git rejected the commit; check the result and try again.',
  'autofix.nothing_to_push': 'There is nothing to push: the worktree has no new commits.',
  'autofix.push_denied':
    'The push was refused by the branch guard. Push only the pull request head branch; do not force push, merge, or push other branches.',
  'autofix.push_failed':
    'The push failed. Check the network and credentials; do not retry with a force push.',
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

export function registerAutoFixGitTools(registry: ToolRegistry, tools: AutoFixGitTools): void {
  registry.register({
    name: GIT_COMMIT_TOOL,
    description:
      'Commit all changes in the auto-fix worktree. Use a concise message describing the fix. This does not push.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message.',
          minLength: 1,
          maxLength: 2000,
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    category: 'execute',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const { message } = input as { message: string }
      try {
        const { sha } = await tools.commit({ message })
        return { content: [{ type: 'text', text: `Committed ${sha}.` }] }
      } catch (error) {
        throw toToolError(error)
      }
    },
  })

  registry.register({
    name: GIT_PUSH_TOOL,
    description:
      'Push the auto-fix commits to the pull request head branch. Cannot force push; cannot push another branch.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    category: 'execute',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute() {
      try {
        const { sha, branch } = await tools.push()
        return { content: [{ type: 'text', text: `Pushed ${sha} to ${branch}.` }] }
      } catch (error) {
        throw toToolError(error)
      }
    },
  })
}
