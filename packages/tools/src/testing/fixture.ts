/**
 * 测试用的固定工作区：在临时目录中按同样的内容生成（不提交到仓库，避免 `.gitignore`、换行与编码被 Git 改写）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  TOOL_OUTPUT_MAX_TOKENS,
  type Logger,
  type ToolContext,
  type ToolDefinition,
} from '@cairn/core'
import { createPathResolver } from '../paths.js'

const utf16le = (text: string) => Buffer.from(text, 'utf16le')

/** 相对路径 → 内容；以 `/` 结尾的键是空目录。 */
export const FIXTURE: Readonly<Record<string, string | Uint8Array>> = {
  '.gitignore': 'dist/\n*.log\n!keep.log\n',
  'README.md': '# Demo\n',
  'app.log': 'ignored\n',
  'keep.log': 'kept\n',
  'dist/out.js': 'ignored\n',
  '.git/HEAD': 'ref: refs/heads/main\n',
  'src/index.ts': "export const a = 1\n\nconsole.log('hi')\n",
  'src/crlf.ts': 'a\r\nb\r\n',
  'src/mixed.txt': 'a\nb\r\nc',
  'src/bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\n世界\n')]),
  'src/utf16le.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('hi\nthere\n')]),
  'src/utf16be.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), utf16le('hi\n').swap16()]),
  'src/latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  'src/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  'src/empty.txt': '',
  'src/nested/.gitignore': 'secret.txt\n',
  'src/nested/secret.txt': 'secret\n',
  'src/nested/visible.txt': 'visible\n',
  'src/nested/deeper/leaf.txt': 'leaf\n',
  'empty-dir/': '',
  'big.txt': Array.from({ length: 3000 }, (_, i) => `${i + 1}`).join('\n') + '\n',
  'wide.txt': Array.from({ length: 1000 }, (_, i) => `${i + 1} ${'x'.repeat(98)}`).join('\n'),
  'long.txt': `${'y'.repeat(2500)}\nshort\n`,
}

export interface Fixture {
  /** 工作区根目录（真实路径）。 */
  readonly root: string
  /** 工作区外的目录。 */
  readonly outside: string
  dispose(): void
}

export async function createFixture(): Promise<Fixture> {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'cairn-tools-')))
  const root = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n')
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const target = path.join(root, ...rel.split('/'))
    if (rel.endsWith('/')) {
      await fs.mkdir(target, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return { root, outside, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

const noopLogger: Logger = {
  level: 'error',
  setLevel: () => {},
  isEnabled: () => false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}

export function toolContext(
  root: string,
  signal: AbortSignal = new AbortController().signal,
  recordChange: ToolContext['recordChange'] = async () => {},
): ToolContext {
  return {
    workspaceRoot: root,
    toolCallId: 'call-1',
    signal,
    resolvePath: createPathResolver(root),
    checkpoints: { create: async () => 'cp' },
    maxOutputTokens: TOOL_OUTPUT_MAX_TOKENS,
    log: noopLogger,
    progress: () => {},
    recordChange,
  }
}

/** 依次执行 `normalize` 与 `execute`，返回文本输出。 */
export async function runTool<I>(
  tool: ToolDefinition<I>,
  input: I,
  ctx: ToolContext,
): Promise<string> {
  const normalized = tool.normalize ? (await tool.normalize(input, ctx)).input : input
  const output = await tool.execute(normalized, ctx)
  return output.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}
