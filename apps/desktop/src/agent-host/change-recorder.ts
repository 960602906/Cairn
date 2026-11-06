/**
 * 宿主一侧的改动记录（M1-08b）：写类工具完成的改动经 `changes.record` 交给主进程，由主进程写入 blob 存储
 * 与数据库（宿主不直接写数据目录）。内容以 base64 传递。工具流水线接入宿主在 M1-10/11。
 */
import type { ToolChangeRecorder } from '@cairn/core'
import type { HostForMain, MainForHost, RpcEndpoint } from '@cairn/protocol'

/** 改动内容较大（最多 10 MiB）时传输需要时间，超时放宽到 60 秒。 */
export const CHANGE_RECORD_TIMEOUT_MS = 60_000

const base64 = (content: Uint8Array) =>
  Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('base64')

export function createHostChangeRecorder(
  endpoint: Pick<RpcEndpoint<typeof HostForMain, typeof MainForHost>, 'request'>,
): ToolChangeRecorder {
  return {
    record: (change) =>
      endpoint.request(
        'changes.record',
        {
          path: change.path,
          kind: change.kind,
          ...(change.before === undefined ? {} : { before: base64(change.before) }),
          ...(change.after === undefined ? {} : { after: base64(change.after) }),
          toolCallId: change.toolCallId,
          ...(change.turnId === undefined ? {} : { turnId: change.turnId }),
          hunks: [...change.hunks],
          added: change.added,
          removed: change.removed,
        },
        { timeoutMs: CHANGE_RECORD_TIMEOUT_MS },
      ),
  }
}
