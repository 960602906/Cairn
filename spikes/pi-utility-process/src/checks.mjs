// @ts-check
/**
 * 根据宿主的观察结果（`scenario.mjs`、`probe.mjs`）与 mock 端点记录的请求判定各项检查。
 * Node 与 Electron 两种运行方式共用。
 */
import { readdirSync } from 'node:fs'
import { API_KEY, REASONING, TOOL_REPLY } from './mock-server.mjs'

/**
 * @param {object} input
 * @param {any} input.observed `{ probe, scenarios }`，或 `{ error }`（宿主未能完成）
 * @param {import('./mock-server.mjs').RecordedRequest[]} input.requests
 * @param {string} input.baseUrl
 * @param {string} input.home 运行时作为 HOME / USERPROFILE 的空目录
 */
export function evaluate({ observed, requests, baseUrl, home }) {
  /** @type {{ name: string, ok: boolean, detail?: unknown }[]} */
  const checks = []
  const check = (name, ok, detail) =>
    checks.push(
      detail === undefined ? { name, ok: Boolean(ok) } : { name, ok: Boolean(ok), detail },
    )

  if (observed?.error || !observed?.scenarios) {
    check('host completed', false, observed?.error ?? 'no result')
    return checks
  }
  const { tool, abort, error } = observed.scenarios
  const byModel = (id) => requests.filter((r) => r.model === id)

  check('pi loads', true, { loadMs: Math.round(observed.scenarios.loadMs) })

  check('tool: prompt resolves', tool.error === null, tool.error ?? undefined)
  check('tool: model requests the tool call', tool.firstStopReason === 'toolUse', {
    stopReason: tool.firstStopReason,
    call: tool.requestedCall,
  })
  check(
    'tool: tool executed with parsed arguments',
    JSON.stringify(tool.toolCalls) === JSON.stringify([{ a: 2, b: 3 }]),
    tool.toolCalls,
  )
  const toolRequests = byModel('tool-model')
  const second = toolRequests[1]
  check(
    'tool: result sent back with the call id',
    toolRequests.length === 2 &&
      second?.toolResults.length === 1 &&
      second.toolResults[0]?.toolCallId === 'call_add_1' &&
      JSON.stringify(second.toolResults[0]?.content).includes('5'),
    second?.toolResults,
  )
  check('tool: final reply', tool.finalText === TOOL_REPLY && tool.finalStopReason === 'stop', {
    text: tool.finalText,
    stopReason: tool.finalStopReason,
  })
  check('tool: text streamed as deltas', tool.deltas.text >= 2, tool.deltas)
  check('tool: reasoning_content parsed as thinking', tool.thinking === REASONING, tool.thinking)
  check(
    'requests: streaming with the injected API key',
    requests.length > 0 &&
      requests.every((r) => r.stream && r.authorization === `Bearer ${API_KEY}`),
    requests.map((r) => ({
      model: r.model,
      stream: r.stream,
      auth: r.authorization === `Bearer ${API_KEY}`,
    })),
  )

  const slow = byModel('slow-model')
  check('abort: prompt resolves', abort.error === null, abort.error ?? undefined)
  check('abort: stopReason aborted', abort.stopReason === 'aborted', {
    stopReason: abort.stopReason,
    textDeltas: abort.textDeltas,
    settleMs: abort.settleMsAfterAbort === null ? null : Math.round(abort.settleMsAfterAbort),
  })
  check(
    'abort: HTTP request closed early',
    slow.length === 1 && slow[0]?.closedEarly === true,
    slow.map((r) => r.closedEarly),
  )

  check('error: prompt resolves', error.error === null, error.error ?? undefined)
  check('error: stopReason error', error.stopReason === 'error', {
    stopReason: error.stopReason,
    errorMessage: error.errorMessage,
    attempts: byModel('auth-fail-model').length,
  })

  const { probe } = observed
  const outbound = probe.fetchUrls.filter((url) => !url.startsWith(baseUrl))
  check('no outbound requests besides the endpoint', outbound.length === 0, outbound)
  const homeEntries = readdirSync(home)
  check('nothing written to HOME', homeEntries.length === 0, homeEntries)
  return checks
}
