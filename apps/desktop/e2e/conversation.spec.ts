/**
 * 完成标准场景 1～3（M0-16b，架构 §26）：
 * 1. 新建会话 → 输入 → 看到流式回复 → 完成；
 * 2. 数据库中有对应的持久化事件，没有增量事件；
 * 3. 关闭并重启应用 → 历史完整显示 → 继续对话，宿主收到完整历史。
 *
 * M0 的宿主使用 FakeRuntime：原样回复输入，逐字输出（每字 15 ms）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CanonicalMessage } from '@nexus/protocol'
import { HOST_TRACE_ENV, type HostTraceRecord } from '../src/agent-host/history-trace.js'
import { expect, test } from './app.js'
import { contentText, readEvents, type StoredEvent } from './database.js'
import {
  converse,
  createSession,
  expectMessages,
  openSession,
  projectDir,
  recordLiveText,
  runStatus,
  sendPrompt,
} from './session.js'

const TITLE = '端到端测试'
/** 回复约 40 个字符，流式输出约 0.6 秒，足以观察到多次中间状态。 */
const PROMPT = '请原样回复这句话：端到端测试检查流式回复逐字出现，完成后整条消息只显示一次。'

const ofType = (events: readonly StoredEvent[], type: string) =>
  events.filter((event) => event.type === type)

test('新建会话并输入：回复流式出现，完成后只显示一次', async ({ launch, userData }) => {
  const { window } = await launch()
  await createSession(window, projectDir(userData), TITLE)
  await expect(runStatus(window)).toHaveText('空闲')
  await expectMessages(window, [])

  const liveText = await recordLiveText(window)
  await sendPrompt(window, PROMPT)
  await expect(runStatus(window)).toContainText('运行中')
  await expectMessages(window, [
    ['你', PROMPT],
    ['助手', PROMPT],
  ])
  await expect(runStatus(window)).toHaveText('空闲')

  // 进行中的消息依次显示回复的前缀，逐步变长
  const partials = await liveText()
  for (const [i, text] of partials.entries()) {
    expect(PROMPT.startsWith(text), text).toBe(true)
    if (i > 0) expect(text.length).toBeGreaterThan(partials[i - 1]!.length)
  }
  expect(partials.filter((text) => text.length < PROMPT.length).length).toBeGreaterThan(1)
})

test('落库：一轮对话的持久化事件完整，增量事件不落库', async ({ launch, userData }) => {
  const app = await launch()
  await createSession(app.window, projectDir(userData), TITLE)
  await converse(app.window, PROMPT)
  await app.close()

  const events = readEvents(userData)
  const types = events.map((event) => event.type)
  expect(new Set(events.map((event) => event.sessionId)).size).toBe(1)
  expect(types.filter((type) => type.endsWith('.delta'))).toEqual([])
  for (const type of [
    'session.created',
    'run.created',
    'message.user',
    'turn.started',
    'step.started',
    'message.assistant.completed',
    'step.completed',
    'turn.completed',
  ]) {
    expect(ofType(events, type), type).toHaveLength(1)
  }
  expect(types.indexOf('message.user')).toBeLessThan(types.indexOf('turn.started'))
  expect(types.indexOf('turn.started')).toBeLessThan(types.indexOf('step.started'))
  expect(types.indexOf('step.started')).toBeLessThan(types.indexOf('message.assistant.completed'))
  expect(types.indexOf('step.completed')).toBeLessThan(types.indexOf('turn.completed'))

  expect(contentText(ofType(events, 'message.user')[0]!.payload['content'])).toBe(PROMPT)
  const reply = ofType(events, 'message.assistant.completed')[0]!
  expect(contentText(reply.payload['content'])).toBe(PROMPT)

  // seq 严格递增；增量与持久化事件共用计数器，所以流式输出期间的 seq 在库中留下空缺
  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
  }
  const stepStarted = ofType(events, 'step.started')[0]!
  expect(reply.seq - stepStarted.seq).toBeGreaterThan(1)
})

test('重启应用：历史完整恢复，继续对话时宿主收到完整历史', async ({ launch, userData }) => {
  const trace = path.join(userData, 'host-trace.jsonl')
  const env = { [HOST_TRACE_ENV]: trace }

  const first = await launch({ env })
  await createSession(first.window, projectDir(userData), TITLE)
  let messages = await converse(first.window, '第一条')
  messages = await converse(first.window, '第二条', messages)
  await first.close()

  const second = await launch({ env })
  await openSession(second.window, TITLE)
  await expect(runStatus(second.window)).toHaveText('空闲')
  await expectMessages(second.window, messages)
  await converse(second.window, '第三条', messages)

  // 每个宿主进程创建一次运行时会话：首次为新运行（无历史），重启后带着之前的两问两答
  const records = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as HostTraceRecord)
  const summarize = (history: readonly CanonicalMessage[]) =>
    history.map((m) => [m.role, contentText(m.content)])
  expect(records.map((record) => summarize(record.history))).toEqual([
    [],
    [
      ['user', '第一条'],
      ['assistant', '第一条'],
      ['user', '第二条'],
      ['assistant', '第二条'],
    ],
  ])

  // 重启后继续的是同一个运行，三轮各有不同的轮次 id
  await second.close()
  const events = readEvents(userData)
  const runs = ofType(events, 'run.created')
  expect(runs).toHaveLength(1)
  const turnEvents = events.filter((event) => event.turnId !== null)
  expect(new Set(turnEvents.map((event) => event.runId))).toEqual(new Set([runs[0]!.runId]))
  const turns = ofType(events, 'turn.completed').map((event) => event.turnId)
  expect(new Set(turns).size).toBe(3)
})
