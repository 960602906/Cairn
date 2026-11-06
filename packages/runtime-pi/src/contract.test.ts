/**
 * 适配器契约测试（M1-02a；架构 §23；Runtime §18；S8）：用录制的模型响应驱动 `PiRuntime`，
 * 适配器输出的轨迹（`RuntimeEvent`、工具调用、历史）与黄金文件（`contract/golden/<名称>.events.json`）比对。
 * 黄金文件缺失时本地会新建、CI 中直接失败；pi 升级后有差异时，审阅 diff 后用 `vitest run -u` 更新。
 *
 * 另外验证：
 * - 稳定复现：同一录制在不同分块方式下、多次重复回放，轨迹完全相同；
 * - 合成录制可复现：用合成上游重新录制，请求与响应内容与仓库中的录制相同，直连时的轨迹与黄金文件相同；
 * - 录制文件不含凭据。
 *
 * 录制新文件见 `contract-record.test.ts`。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CASSETTE_VERSION,
  KEY_LIKE,
  PLACEHOLDER_KEY,
  loadCassette,
  normalizeRequestBody,
  recordRequest,
  saveCassette,
  type Cassette,
  type Interaction,
} from './testing/contract/cassette.js'
import { startRecordingProxy } from './testing/contract/record-proxy.js'
import { recordScenario } from './testing/contract/record.js'
import { startReplayServer, type Chunking } from './testing/contract/replay-server.js'
import { SCENARIOS, findScenario, runScenario } from './testing/contract/scenarios.js'
import { normalizeRun, serializeTrace } from './testing/contract/trace.js'
import { startUpstreamMock } from './testing/contract/upstream-mock.js'

const root = path.resolve(import.meta.dirname, '../contract')
const cassetteFile = (name: string) => path.join(root, 'cassettes', `${name}.json`)
const goldenFile = (name: string) => path.join(root, 'golden', `${name}.events.json`)

const CHUNKINGS: readonly Chunking[] = [
  'whole',
  { bytes: 1 },
  { bytes: 2 },
  { bytes: 3 },
  { bytes: 64 },
  ...Array.from({ length: 10 }, (_, i) => ({ seed: i + 1 })),
]
const REPEATS = 5

async function replay(cassette: Cassette, chunking?: Chunking, prompt?: string) {
  const server = await startReplayServer(cassette, chunking ? { chunking } : {})
  const base = findScenario(cassette.scenario)
  try {
    const run = await runScenario(prompt === undefined ? base : { ...base, prompt }, {
      baseUrl: server.baseUrl,
      apiKey: PLACEHOLDER_KEY,
      model: cassette.model,
      reasoning: cassette.reasoning,
    })
    return {
      trace: normalizeRun(run),
      mismatches: server.mismatches,
      remaining: server.remaining(),
    }
  } finally {
    await server.close()
  }
}

/** `contract/cassettes/` 下的全部录制（含从真实服务录制的），按录制中记录的场景与模型回放。 */
const CASSETTES = readdirSync(path.join(root, 'cassettes'))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => loadCassette(path.join(root, 'cassettes', file)))

describe.each(CASSETTES.map((cassette) => ({ name: cassette.name, cassette })))(
  '$name',
  ({ cassette }) => {
    it('回放得到与黄金文件相同的轨迹', async () => {
      const result = await replay(cassette)
      expect(result.mismatches).toEqual([])
      expect(result.remaining).toBe(0)
      await expect(serializeTrace(result.trace)).toMatchFileSnapshot(goldenFile(cassette.name))
    })

    it('不同分块方式与重复回放的轨迹完全相同', async () => {
      const reference = await replay(cassette)
      const runs: Chunking[] = [
        ...CHUNKINGS,
        ...Array.from({ length: REPEATS }, () => 'recorded' as const),
      ]
      for (const chunking of runs) {
        const result = await replay(cassette, chunking)
        expect(result.mismatches, JSON.stringify(chunking)).toEqual([])
        expect(result.trace, JSON.stringify(chunking)).toEqual(reference.trace)
      }
    })
  },
)

/** 录制中与网络分块无关的内容。 */
const content = (interactions: readonly Interaction[]) =>
  interactions.map(({ request, response }) => ({
    request,
    status: response.status,
    headers: response.headers,
    body: response.chunks.join(''),
  }))

describe('合成录制', () => {
  it('每个场景都有合成录制', () => {
    for (const { name } of SCENARIOS) {
      expect(existsSync(cassetteFile(name)), name).toBe(true)
      expect(loadCassette(cassetteFile(name)).source, name).toBe('synthetic')
    }
  })

  it('重新录制得到相同的内容，直连时的轨迹与黄金文件相同', async () => {
    const upstream = await startUpstreamMock()
    try {
      for (const scenario of SCENARIOS) {
        const committed = loadCassette(cassetteFile(scenario.name))
        const { cassette, live } = await recordScenario(scenario, {
          upstream: upstream.baseUrl,
          apiKey: PLACEHOLDER_KEY,
          reasoning: committed.reasoning,
          source: 'synthetic',
        })
        expect(
          { ...cassette, interactions: content(cassette.interactions) },
          scenario.name,
        ).toEqual({
          ...committed,
          interactions: content(committed.interactions),
        })
        expect(serializeTrace(normalizeRun(live)), scenario.name).toBe(
          readFileSync(goldenFile(scenario.name), 'utf8'),
        )
      }
    } finally {
      await upstream.close()
    }
  })

  it('合成上游对未编排的请求返回 404', async () => {
    const upstream = await startUpstreamMock()
    try {
      const res = await fetch(`${upstream.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'unknown', messages: [] }),
      })
      expect(res.status).toBe(404)
      expect((await fetch(`${upstream.baseUrl}/other`)).status).toBe(404)
    } finally {
      await upstream.close()
    }
  })
})

describe('回放服务', () => {
  const cassette = loadCassette(cassetteFile('openai-tool'))

  it('请求与录制不一致时报告差异，适配器以失败结束', async () => {
    const result = await replay(cassette, undefined, 'What is 4 + 4?')
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]?.fields).toEqual(['body'])
    expect(result.trace.events.at(-1)).toMatchObject({ type: 'loop.ended', outcome: 'failed' })
  })

  it('录制之外的请求被报告', async () => {
    const result = await replay({ ...cassette, interactions: cassette.interactions.slice(0, 1) })
    expect(result.mismatches.map((m) => m.fields)).toEqual([['unexpected request']])
  })
})

describe('录制代理', () => {
  it('上游不可达时记录 502', async () => {
    const proxy = await startRecordingProxy('http://127.0.0.1:1/')
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/models`)
      expect(res.status).toBe(502)
      expect(proxy.interactions[0]?.response.status).toBe(502)
      expect(proxy.interactions[0]?.request).toMatchObject({
        method: 'GET',
        path: '/v1/models',
        body: null,
      })
    } finally {
      await proxy.close()
    }
  })
})

describe('录制格式', () => {
  it('请求中的凭据不记录，请求体规范化', () => {
    const request = recordRequest(
      {
        method: 'POST',
        url: '/v1beta/models/m:streamGenerateContent?alt=sse&key=secret',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      },
      JSON.stringify({ id: 'add_1767225600000_3', session: 'cairn-12', n: [1, null] }),
    )
    expect(request).toEqual({
      method: 'POST',
      path: '/v1beta/models/m:streamGenerateContent',
      query: { alt: 'sse', key: '<redacted>' },
      headers: { 'content-type': 'application/json' },
      body: { id: 'add_<generated>', session: 'cairn-<session>', n: [1, null] },
    })
    expect(recordRequest({ headers: {} }, 'not json')).toMatchObject({
      method: 'GET',
      path: '/',
      body: 'not json',
    })
    expect(normalizeRequestBody('plain')).toBe('plain')
  })

  it('保存后能读回，拒绝不支持的版本', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cairn-contract-'))
    try {
      const cassette = loadCassette(cassetteFile('openai-tool'))
      const file = path.join(dir, 'c.json')
      saveCassette(file, cassette)
      expect(loadCassette(file)).toEqual(cassette)
      saveCassette(file, { ...cassette, version: CASSETTE_VERSION + 1 })
      expect(() => loadCassette(file)).toThrow(/unsupported cassette version/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('录制文件不含凭据', () => {
    for (const cassette of CASSETTES) {
      const text = readFileSync(cassetteFile(cassette.name), 'utf8')
      expect(text, cassette.name).not.toContain(PLACEHOLDER_KEY)
      expect(KEY_LIKE.test(text), cassette.name).toBe(false)
      for (const { request } of cassette.interactions) {
        const headers = Object.keys(request.headers)
        expect(headers).not.toContain('authorization')
        expect(headers).not.toContain('x-api-key')
        expect(headers).not.toContain('x-goog-api-key')
      }
    }
  })

  it('疑似 Key 的识别', () => {
    expect(KEY_LIKE.test('Bearer sk-abcdefghijklmnopqrstuv')).toBe(true)
    expect(KEY_LIKE.test(`AIza${'x'.repeat(35)}`)).toBe(true)
    expect(KEY_LIKE.test('sk-short')).toBe(false)
  })
})
