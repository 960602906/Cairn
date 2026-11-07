/** 测试用的 stdio MCP 服务（M3-09）：一个 echo 工具。 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'cairn-fixture', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: 'Echo the input text',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }),
)

server.registerTool(
  'structured',
  {
    description: 'Return structured content only',
    inputSchema: {},
  },
  async () => ({
    content: [],
    structuredContent: { ok: true, value: 42 },
  }),
)

server.registerTool(
  'empty',
  {
    description: 'Return no content',
    inputSchema: {},
  },
  async () => ({ content: [] }),
)

server.registerTool(
  'nodesc',
  {
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: 'nodesc' }] }),
)

process.stderr.write('fixture ready\n')
await server.connect(new StdioServerTransport())
