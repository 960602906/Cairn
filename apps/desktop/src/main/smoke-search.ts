/**
 * 冒烟检查中的 `search`（M1-07b）：确认随应用打包的 ripgrep 能找到并运行，`search` 工具能在临时工作区中找到内容。
 * 工具接入宿主前（M1-10、M1-11）只在这里使用；不依赖 Electron，便于单元测试。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_OUTPUT_MAX_TOKENS, type Logger } from '@cairn/core'
import { createPathResolver, createSearchTool, ripgrepVersion } from '@cairn/tools'

const silentLogger: Logger = {
  level: 'error',
  setLevel: () => {},
  isEnabled: () => false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

/** 在 `workspace` 中写入一个文件并搜索它，返回 ripgrep 版本。结果不对时抛出。 */
export async function checkBundledSearch(ripgrepPath: string, workspace: string): Promise<string> {
  const version = await ripgrepVersion(ripgrepPath)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'smoke.txt'), 'first line\nsmoke needle\n')
  const tool = createSearchTool({ ripgrepPath })
  const output = await tool.execute(
    { pattern: 'needle' },
    {
      workspaceRoot: workspace,
      toolCallId: 'smoke-search',
      signal: new AbortController().signal,
      resolvePath: createPathResolver(workspace),
      checkpoints: { create: () => Promise.reject(new Error('not used')) },
      maxOutputTokens: TOOL_OUTPUT_MAX_TOKENS,
      log: silentLogger,
      progress: () => {},
      recordChange: () => Promise.reject(new Error('not used')),
    },
  )
  const text = output.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
  if (!text.includes('smoke.txt\n  2: smoke needle')) {
    throw new Error(`search returned an unexpected result: ${text}`)
  }
  return version
}
