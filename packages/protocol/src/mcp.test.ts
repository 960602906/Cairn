import { describe, expect, it } from 'vitest'
import { McpServerInput, McpServerSummary, McpStatusEvent, McpToolExposure } from './mcp.js'

describe('MCP protocol', () => {
  it('accepts stdio and http inputs', () => {
    expect(
      McpServerInput.parse({
        name: 'Local',
        kind: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: [{ name: 'TOKEN', value: 'secret' }],
      }),
    ).toMatchObject({ kind: 'stdio', command: 'node' })
    expect(
      McpServerInput.parse({
        name: 'Remote',
        kind: 'http',
        url: 'https://example.com/mcp',
        auth: 'header',
        headerName: 'X-API-Key',
        token: 'secret',
      }),
    ).toMatchObject({ kind: 'http', auth: 'header' })
  })

  it('requires kind-specific fields', () => {
    expect(() => McpServerInput.parse({ name: 'A', kind: 'stdio' })).toThrow(/command/)
    expect(() => McpServerInput.parse({ name: 'B', kind: 'http' })).toThrow(/url/)
    expect(() =>
      McpServerInput.parse({ name: 'C', kind: 'http', url: 'https://e.com', auth: 'header' }),
    ).toThrow(/headerName/)
  })

  it('rejects invalid environment variable names', () => {
    expect(() =>
      McpServerInput.parse({
        name: 'A',
        kind: 'stdio',
        command: 'node',
        env: [{ name: '1BAD', value: 'x' }],
      }),
    ).toThrow()
  })

  it('parses summaries, tool exposures and status events', () => {
    expect(
      McpServerSummary.parse({
        serverId: 'm1',
        name: 'A',
        kind: 'stdio',
        enabled: true,
        status: 'connected',
        toolCount: 1,
        updatedAt: 1,
      }),
    ).toMatchObject({ status: 'connected' })
    expect(
      McpToolExposure.parse({
        name: 'mcp_a_echo',
        description: '',
        inputSchema: { type: 'object' },
        serverId: 'm1',
        originalName: 'echo',
        category: 'network',
      }),
    ).toMatchObject({ originalName: 'echo' })
    expect(McpStatusEvent.parse({ serverId: 'm1', status: 'error', toolCount: 0 })).toMatchObject({
      status: 'error',
    })
  })
})
