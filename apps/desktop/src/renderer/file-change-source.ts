/**
 * 文件标签的改动来源：一个文件可能同时出现在主工作区的会话改动与子运行待审阅的改动集里。
 *
 * 优先级：会话改动（已经写进主工作区）优先；其次是待审阅（`pending`）的改动集。
 * 改动集详情按需读取（`changeset.get`），命中缓存后打开别的文件不再请求；同一改动集的
 * 并发调用由 `ensureChangeSetLoaded` 去重。
 */
import { useEffect, useMemo } from 'react'
import type { ChangeSetFileInfo, ChangeSetSummary } from '@cairn/protocol'
import { fileEntries, type FileEntry } from './file-changes.js'
import { useSessionStore } from './store-context.js'

export type FileChangeSource =
  /** 还在判断：有待审阅改动集的详情没读完。 */
  | { readonly status: 'loading' }
  /** 这个文件没有改动，显示源码预览。 */
  | { readonly status: 'none' }
  /** 主工作区的会话改动。 */
  | { readonly status: 'session'; readonly entry: FileEntry }
  /** 子运行待审阅的改动集。 */
  | {
      readonly status: 'changeSet'
      readonly changeSet: ChangeSetSummary
      readonly file: ChangeSetFileInfo
      /** 同一文件还出现在其余几个待审阅改动集里。 */
      readonly additional: number
    }

export function useFileChangeSource(sessionId: string | undefined, path: string): FileChangeSource {
  const changes = useSessionStore((state) =>
    sessionId === undefined ? undefined : state.changes[sessionId],
  )
  const changeSets = useSessionStore((state) =>
    sessionId === undefined ? undefined : state.changeSets?.[sessionId],
  )
  const details = useSessionStore((state) => state.changeSetDetails)
  const errors = useSessionStore((state) => state.changeSetErrors)
  const ensureChangeSetLoaded = useSessionStore((state) => state.ensureChangeSetLoaded)
  const entry = useMemo(
    () => (changes === undefined ? undefined : fileEntries(changes).find((e) => e.path === path)),
    [changes, path],
  )
  const pending = useMemo(
    () => (changeSets ?? []).filter((changeSet) => changeSet.status === 'pending'),
    [changeSets],
  )
  const matches = useMemo(
    () =>
      pending.flatMap((changeSet) => {
        const file = details[changeSet.changeSetId]?.files.find((item) => item.path === path)
        return file === undefined ? [] : [{ changeSet, file }]
      }),
    [details, path, pending],
  )
  const missing = pending.some(
    (changeSet) =>
      details[changeSet.changeSetId] === undefined && errors[changeSet.changeSetId] === undefined,
  )

  useEffect(() => {
    if (sessionId === undefined) return
    for (const changeSet of pending) {
      if (
        details[changeSet.changeSetId] !== undefined ||
        errors[changeSet.changeSetId] !== undefined
      )
        continue
      void ensureChangeSetLoaded(sessionId, changeSet.changeSetId)
    }
  }, [details, ensureChangeSetLoaded, errors, pending, sessionId])

  if (entry !== undefined) return { status: 'session', entry }
  const first = matches[0]
  if (first !== undefined)
    return {
      status: 'changeSet',
      changeSet: first.changeSet,
      file: first.file,
      additional: matches.length - 1,
    }
  return missing ? { status: 'loading' } : { status: 'none' }
}
