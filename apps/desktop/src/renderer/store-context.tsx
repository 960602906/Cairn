/**
 * 把会话 store 提供给组件（M0-15b）。组件用 `useSessionStore(selector)` 读取状态与动作。
 */
import { createContext, useContext, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { SessionActions, SessionState, SessionStore } from './session-store.js'

const StoreContext = createContext<SessionStore | undefined>(undefined)

export function SessionStoreProvider({
  store,
  children,
}: {
  readonly store: SessionStore
  readonly children: ReactNode
}) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useSessionStore<T>(selector: (state: SessionState & SessionActions) => T): T {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useSessionStore must be used inside SessionStoreProvider')
  return useStore(store, selector)
}
