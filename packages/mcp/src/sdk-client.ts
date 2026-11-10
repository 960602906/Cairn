/**
 * 官方 TypeScript SDK 的薄包装（M3-09）。只有这个文件接触 `@modelcontextprotocol/sdk`。
 */
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpCallOptions, McpCallResult, McpClient, McpServerSpec, McpTool } from './types.js'

export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) {
    return content === undefined ? '' : JSON.stringify(content)
  }
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) {
      parts.push(String(raw))
      continue
    }
    const item = raw as Record<string, unknown>
    switch (item['type']) {
      case 'text':
        parts.push(typeof item['text'] === 'string' ? item['text'] : '')
        break
      case 'image':
        parts.push(`[image ${String(item['mimeType'] ?? 'unknown')}]`)
        break
      case 'audio':
        parts.push(`[audio ${String(item['mimeType'] ?? 'unknown')}]`)
        break
      case 'resource': {
        const resource = item['resource']
        if (typeof resource === 'object' && resource !== null) {
          const value = resource as Record<string, unknown>
          if (typeof value['text'] === 'string') parts.push(value['text'])
          else parts.push(`[resource ${String(value['uri'] ?? 'unknown')}]`)
        } else {
          parts.push('[resource]')
        }
        break
      }
      default:
        parts.push(JSON.stringify(item))
    }
  }
  return parts.join('\n')
}

/**
 * Windows 上 `npx`、`uvx` 这类命令其实是 `.cmd` / `.bat` 脚本，不经过 shell 无法直接启动
 * （Node 会报 ENOENT 或 EINVAL）。不是 `.exe` / `.com` 的命令改由 `cmd.exe /d /c` 启动；
 * 结束时按进程树结束，`cmd.exe` 下的子进程一起退出。
 */
export function stdioCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env['ComSpec'],
): { command: string; args: string[] } {
  if (platform !== 'win32' || /\.(exe|com)$/i.test(command)) {
    return { command, args: [...args] }
  }
  return { command: comspec || 'cmd.exe', args: ['/d', '/c', command, ...args] }
}

export function createSdkClient(spec: McpServerSpec): McpClient {
  const client = new Client({ name: 'cairn', version: '0.0.0' })
  let closed = false
  let closeListener: (() => void) | undefined
  let logListener: ((line: string) => void) | undefined
  /** 启动过的 stdio 传输；连接失败或超时也要按它的 pid 结束子进程。 */
  let stdio: StdioClientTransport | undefined
  const connectTimeout = spec.connectTimeoutMs ?? 15_000
  const callTimeout = spec.callTimeoutMs ?? 60_000

  return {
    async connect() {
      let transport: StdioClientTransport | StreamableHTTPClientTransport
      if (spec.transport.kind === 'stdio') {
        const launch = stdioCommand(spec.transport.command, spec.transport.args ?? [])
        transport = new StdioClientTransport({
          command: launch.command,
          ...(launch.args.length > 0 ? { args: launch.args } : {}),
          ...(spec.transport.cwd ? { cwd: spec.transport.cwd } : {}),
          ...(spec.transport.env ? { env: { ...spec.transport.env } } : {}),
          stderr: 'pipe',
        })
        stdio = transport
        transport.stderr?.on('data', (chunk: unknown) => {
          const text = String(chunk).trim()
          if (text) logListener?.(text)
        })
      } else {
        transport = new StreamableHTTPClientTransport(new URL(spec.transport.url), {
          ...(spec.transport.headers
            ? { requestInit: { headers: { ...spec.transport.headers } } }
            : {}),
        })
      }
      client.onclose = () => {
        if (!closed) closeListener?.()
      }
      await client.connect(transport, { timeout: connectTimeout })
    },

    async listTools() {
      const result = await client.listTools(undefined, { timeout: connectTimeout })
      return result.tools.map((tool): McpTool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
      }))
    },

    async callTool(
      name: string,
      input: Readonly<Record<string, unknown>>,
      options: McpCallOptions = {},
    ): Promise<McpCallResult> {
      const result = await client.callTool({ name, arguments: { ...input } }, undefined, {
        timeout: options.timeoutMs ?? callTimeout,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const text =
        contentToText(result.content).trim() ||
        (result.structuredContent === undefined
          ? ''
          : JSON.stringify(result.structuredContent, null, 2))
      return { text, isError: result.isError === true }
    },

    async close() {
      closed = true
      const pid = stdio?.pid ?? null
      stdio = undefined
      await client.close().catch(() => undefined)
      terminateProcessTree(pid)
    },

    onClose(listener) {
      closeListener = listener
    },

    onLog(listener) {
      logListener = listener
    },
  }
}

/** 退出时结束 stdio MCP 子进程树；远程传输没有 pid。 */
function terminateProcessTree(pid: number | null): void {
  if (pid === null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  /* v8 ignore next 3 -- 只在非 Windows 平台执行 */
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 进程已经退出
  }
}
