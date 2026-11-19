/**
 * 设置分类的数据缓存：设置页按分类条件渲染，切走即卸载，列表数据放模块级缓存，
 * 回来时先用上次的结果渲染、后台再刷新一次，不会“先空一下再出现”。
 *
 * - 同一 key 的并发读取合并成一次请求。
 * - 读取失败保留旧数据，由 `failed` 告知调用方（不抛给页面）。
 * - 缓存只在渲染进程内有效；写操作之后由调用方 `reload()`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const values = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()

/** 直接读取缓存；没有缓存时为 undefined。 */
export function peekSettingsData<T>(key: string): T | undefined {
  return values.get(key) as T | undefined
}

/** 写入或清空一项缓存。 */
export function setSettingsData<T>(key: string, value: T | undefined): void {
  if (value === undefined) values.delete(key)
  else values.set(key, value)
}

/**
 * 读取并缓存一项数据；同 key 的并发调用共享同一个请求。
 * `loader` 返回 undefined（各加载动作约定的失败）或抛错都保留旧缓存并返回 undefined。
 */
export function loadSettingsData<T>(
  key: string,
  loader: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const inflight = pending.get(key) as Promise<T | undefined> | undefined
  if (inflight) return inflight
  const task = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (value !== undefined) values.set(key, value)
      return value
    })
    .catch(() => undefined)
    .finally(() => {
      pending.delete(key)
    })
  pending.set(key, task)
  return task
}

/** 清空全部缓存；测试里用来隔离用例。 */
export function clearSettingsData(): void {
  values.clear()
  pending.clear()
}

export interface SettingsData<T> {
  /** 最近一次成功读取的数据；从未成功过时为 undefined。 */
  readonly value: T | undefined
  /** 最近一次读取是否失败（此前读到的数据仍会保留）。 */
  readonly failed: boolean
  /** 直接写入已知的新数据（写操作的返回值），同时更新缓存。 */
  set(value: T): void
  /** 重新读取；写操作之后调用。 */
  reload(): Promise<T | undefined>
}

/**
 * 订阅一项缓存数据：挂载时先用缓存渲染，同时后台刷新；没有缓存时才处于“加载中”。
 * `loader` 每次读最新闭包，不必放进依赖；`key` 变化时会重新取对应缓存。
 */
export function useSettingsData<T>(
  key: string,
  loader: () => Promise<T | undefined>,
): SettingsData<T> {
  const [keyState, setKeyState] = useState(key)
  const [value, setValue] = useState<T | undefined>(() => peekSettingsData<T>(key))
  const [failed, setFailed] = useState(false)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const active = useRef(true)

  if (keyState !== key) {
    setKeyState(key)
    setValue(peekSettingsData<T>(key))
    setFailed(false)
  }

  const set = useCallback(
    (next: T) => {
      setSettingsData(key, next)
      setValue(next)
      setFailed(false)
    },
    [key],
  )

  const reload = useCallback(async () => {
    const result = await loadSettingsData(key, () => loaderRef.current())
    if (!active.current) return result
    if (result === undefined) {
      setFailed(true)
    } else {
      setFailed(false)
      setValue(result)
    }
    return result
  }, [key])

  useEffect(() => {
    active.current = true
    void reload()
    return () => {
      active.current = false
    }
  }, [reload])

  return { value, failed, set, reload }
}
