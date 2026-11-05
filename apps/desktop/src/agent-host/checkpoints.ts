/**
 * 宿主中的检查点（M1-12b，ADR-0008，架构 §11.2）：按 `host.init` 给出的影子仓库目录与会话的引用
 * 打开影子仓库（`@nexus/checkpoint`），交给运行（每轮开始）与工具流水线（执行命令前）使用。
 *
 * - 宿主启动时就在后台打开；这个会话还没有检查点时立即在后台创建首个检查点（项目第一次打开时
 *   约需十几秒），之后的检查点排在它后面。
 * - 没有可用的 Git（未安装或版本过低）时检查点不可用：`create` 返回 undefined，运行与命令照常进行，
 *   写文件类工具的改动记录仍可撤销。
 * - 其他打开失败（如磁盘错误）时 `create` 抛出（命令前由流水线请用户确认是否不带检查点继续），
 *   下次调用时重新打开。
 */
import {
  CheckpointError,
  CheckpointErrorCode,
  type ShadowRepo,
  type ShadowRepoOptions,
} from '@nexus/checkpoint'
import type { CheckpointReason, ToolCheckpoints } from '@nexus/core'

type Repo = Pick<ShadowRepo, 'head' | 'checkpoint'>

export type OpenShadowRepo = (options: ShadowRepoOptions) => Promise<Repo>

export interface HostCheckpointsOptions {
  readonly gitDir: string
  readonly ref: string
  readonly workTree: string
  readonly open: OpenShadowRepo
  /** 后台创建首个检查点失败、Git 不可用等情况的记录。 */
  readonly onError?: (error: unknown) => void
}

export interface HostCheckpoints extends ToolCheckpoints {
  /** 打开影子仓库的结果：false 表示检查点不可用（没有可用的 Git）。 */
  available(): Promise<boolean>
}

const MESSAGES: Readonly<Record<CheckpointReason, string>> = {
  turn_start: 'turn start',
  before_command: 'before command',
}

export function createHostCheckpoints(options: HostCheckpointsOptions): HostCheckpoints {
  const onError = (error: unknown) => options.onError?.(error)
  let opening: Promise<Repo | undefined> | undefined

  const open = (): Promise<Repo | undefined> => {
    opening ??= options
      .open({ gitDir: options.gitDir, workTree: options.workTree, ref: options.ref })
      .then(
        (repo) => {
          if (repo.head() === undefined) repo.checkpoint('initial').catch(onError)
          return repo
        },
        (error: unknown) => {
          if (
            error instanceof CheckpointError &&
            error.code === CheckpointErrorCode.GitUnavailable
          ) {
            onError(error)
            return undefined
          }
          opening = undefined
          throw error
        },
      )
    return opening
  }
  // 宿主启动时就开始打开；失败在第一次使用时报告
  open().catch(() => undefined)

  return {
    async create(reason) {
      const repo = await open()
      return repo ? (await repo.checkpoint(MESSAGES[reason])).commit : undefined
    },
    available: () => open().then((repo) => repo !== undefined),
  }
}
