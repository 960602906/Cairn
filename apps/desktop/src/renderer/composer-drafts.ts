/**
 * 输入框草稿与新建会话的工作空间偏好（localStorage，只是界面偏好，不进设置）。
 *
 * 打开设置、活动中心或 Agents 页时会话页整体卸载，输入框组件随之销毁；草稿存在这里，
 * 切换回来时能接着写。新对话页的模型与 Agent 按工作空间分别记住：同一个工作空间下次进入仍用它。
 *
 * 存储不可用（隐私模式、测试环境）时全部退化为空草稿，不影响输入。
 */
import type { ModelRef } from '@cairn/protocol'

export interface ComposerDraft {
  readonly text: string
  readonly planMode: boolean
}

/** 新对话页的草稿不区分工作空间：换个工作空间接着写同一段话更符合直觉。 */
export const NEW_SESSION_DRAFT_KEY = 'new'

const DRAFT_PREFIX = 'cairn.composerDraft:'
const NEW_SESSION_PROJECT_KEY = 'cairn.newSession.project'
const NEW_SESSION_MODEL_PREFIX = 'cairn.newSession.model:'
const NEW_SESSION_AGENT_PREFIX = 'cairn.newSession.agent:'

const EMPTY_DRAFT: ComposerDraft = { text: '', planMode: false }

/** 会话输入框的草稿键。 */
export const sessionDraftKey = (sessionId: string) => `session:${sessionId}`

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
  } catch {
    // 存不进去只是下次不记得草稿。
  }
}

export function readComposerDraft(key: string): ComposerDraft {
  const raw = read(DRAFT_PREFIX + key)
  if (raw === null) return EMPTY_DRAFT
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; planMode?: unknown }
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      planMode: parsed.planMode === true,
    }
  } catch {
    return EMPTY_DRAFT
  }
}

/** 空草稿直接删掉键，避免每输入过一次就留下一条记录。 */
export function writeComposerDraft(key: string, draft: ComposerDraft): void {
  write(DRAFT_PREFIX + key, draft.text === '' && !draft.planMode ? null : JSON.stringify(draft))
}

export function clearComposerDraft(key: string): void {
  write(DRAFT_PREFIX + key, null)
}

/** 上一次在新对话页选中的工作空间；没有记录时为 undefined。 */
export function readNewSessionProject(): string | undefined {
  return read(NEW_SESSION_PROJECT_KEY) || undefined
}

export function writeNewSessionProject(projectPath: string): void {
  write(NEW_SESSION_PROJECT_KEY, projectPath === '' ? null : projectPath)
}

/** 某个工作空间上次在新对话页选中的模型；没有记录或记录损坏时为 undefined。 */
export function readNewSessionModel(projectPath: string): ModelRef | undefined {
  if (projectPath === '') return undefined
  const raw = read(NEW_SESSION_MODEL_PREFIX + projectPath)
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as { providerId?: unknown; modelId?: unknown }
    return typeof parsed.providerId === 'string' && typeof parsed.modelId === 'string'
      ? { providerId: parsed.providerId, modelId: parsed.modelId }
      : undefined
  } catch {
    return undefined
  }
}

export function writeNewSessionModel(projectPath: string, model: ModelRef): void {
  if (projectPath === '') return
  write(
    NEW_SESSION_MODEL_PREFIX + projectPath,
    JSON.stringify({ providerId: model.providerId, modelId: model.modelId }),
  )
}

/** 某个工作空间上次在新对话页选中的 Agent id；没有记录或记录损坏时为 undefined。 */
export function readNewSessionAgent(projectPath: string): string | undefined {
  if (projectPath === '') return undefined
  return read(NEW_SESSION_AGENT_PREFIX + projectPath) || undefined
}

export function writeNewSessionAgent(projectPath: string, agentId: string): void {
  if (projectPath === '') return
  write(NEW_SESSION_AGENT_PREFIX + projectPath, agentId === '' ? null : agentId)
}
