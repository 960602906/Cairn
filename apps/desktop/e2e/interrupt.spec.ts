/**
 * 完成标准场景 4～5（M0-16c，架构 §26）：
 * 4. 运行中点击停止 → `turn.aborted`；
 * 5. 强制结束宿主进程 → 界面显示崩溃提示，可以继续对话。
 *
 * M0 的宿主使用 FakeRuntime：原样回复输入，逐字输出（每字 15 ms）。用两百多字的输入让回复持续约 3 秒，
 * 在回复开始出现后再操作，确保停止与结束进程都发生在一轮进行中。
 */
import { expect, test } from './app.js'
import { contentText, ofType, readEvents } from './database.js'
import { agentHostPids, hostTrace, readHostHistories } from './host.js'
import {
  converse,
  createSession,
  expectMessages,
  liveMessage,
  messageTexts,
  projectDir,
  runStatus,
  sendPrompt,
  type ExpectedMessage,
} from './session.js'

const TITLE = '端到端测试'
const LONG_PROMPT = '这是一段很长的输入，用来在回复过程中停止或结束宿主进程。'.repeat(8)
const CRASH_TEXT = 'Agent 进程意外退出，可以从最后保存的位置继续。'

test('运行中停止：本轮以 turn.aborted 结束，之后可以继续对话', async ({ launch, userData }) => {
  const app = await launch()
  const { window } = app
  await createSession(window, projectDir(userData), TITLE)

  await sendPrompt(window, LONG_PROMPT)
  await expect(liveMessage(window)).toContainText(LONG_PROMPT.slice(0, 5))
  await window.getByRole('button', { name: '停止' }).click()

  // 停止后已输出的部分回复保留，注明未完成（Runtime §10.2）
  await expect(window.getByText('已停止', { exact: true })).toBeVisible()
  await expect(runStatus(window)).toHaveText('空闲')
  await expect(window.getByRole('button', { name: '停止' })).toHaveCount(0)
  await expect(window.getByText('（回复未完成）')).toHaveCount(1)
  const partial = (await messageTexts(window)).at(-1)!
  expect(partial.length).toBeGreaterThan(0)
  expect(LONG_PROMPT.startsWith(partial)).toBe(true)
  expect(partial.length).toBeLessThan(LONG_PROMPT.length)
  const stopped: ExpectedMessage[] = [
    ['你', LONG_PROMPT],
    ['助手', partial],
  ]
  await expectMessages(window, stopped)

  await converse(window, '继续', stopped)
  await expect(window.getByText('已停止', { exact: true })).toHaveCount(0)
  await app.close()

  const events = readEvents(userData)
  const aborted = ofType(events, 'turn.aborted')
  expect(aborted.map((event) => event.payload['reason'])).toEqual(['user'])
  const replies = ofType(events, 'message.assistant.completed')
  expect(replies.map((event) => contentText(event.payload['content']))).toEqual([partial, '继续'])
  expect(replies.map((event) => event.payload['incomplete'])).toEqual([true, undefined])
  const completed = ofType(events, 'turn.completed')
  expect(completed).toHaveLength(1)
  expect(completed[0]!.turnId).not.toBe(aborted[0]!.turnId)
})

test('强制结束宿主进程：界面显示崩溃提示，继续对话时新宿主收到保存的历史', async ({
  launch,
  userData,
}) => {
  const trace = hostTrace(userData)
  const app = await launch({ env: trace.env })
  const { window } = app
  await createSession(window, projectDir(userData), TITLE)
  const before = await converse(window, '第一条')

  await sendPrompt(window, LONG_PROMPT)
  await expect(liveMessage(window)).toContainText(LONG_PROMPT.slice(0, 5))
  const [pid, ...others] = await agentHostPids(app.app)
  expect(pid).toBeDefined()
  expect(others).toEqual([])
  process.kill(pid!, 'SIGKILL')

  // 崩溃后进行中的回复被丢弃；可以直接输入，不需要停止
  await expect(window.getByText(CRASH_TEXT)).toBeVisible()
  await expect(runStatus(window)).toHaveText('已崩溃')
  const crashed: ExpectedMessage[] = [...before, ['你', LONG_PROMPT]]
  await expectMessages(window, crashed)
  await expect(window.getByRole('button', { name: '停止' })).toHaveCount(0)
  await expect.poll(() => agentHostPids(app.app)).toEqual([])

  await converse(window, '继续', crashed)
  await expect(window.getByText(CRASH_TEXT)).toHaveCount(0)
  const restarted = await agentHostPids(app.app)
  expect(restarted).toHaveLength(1)
  expect(restarted[0]).not.toBe(pid)

  // 新宿主收到的历史：第一轮的一问一答，以及被中断那一轮的输入
  expect(readHostHistories(trace.file)).toEqual([
    [],
    [
      ['user', '第一条'],
      ['assistant', '第一条'],
      ['user', LONG_PROMPT],
    ],
  ])
  await app.close()

  // 崩溃记录为 session.crashed；继续时被中断的一轮补记 turn.aborted，运行标记为中断后沿用
  const events = readEvents(userData)
  const crashes = ofType(events, 'session.crashed')
  expect(crashes.map((event) => (event.payload['error'] as { code: string }).code)).toEqual([
    'host.exited',
  ])
  expect(ofType(events, 'turn.aborted').map((event) => event.payload['reason'])).toEqual([
    'shutdown',
  ])
  const interrupted = ofType(events, 'run.state.changed').filter(
    (event) => event.payload['to'] === 'interrupted',
  )
  expect(interrupted.map((event) => event.payload['reason'])).toEqual(['host_lost'])
  expect(ofType(events, 'run.created')).toHaveLength(1)
  expect(ofType(events, 'turn.completed')).toHaveLength(2)
  const replies = ofType(events, 'message.assistant.completed')
  expect(replies.map((event) => contentText(event.payload['content']))).toEqual(['第一条', '继续'])
})
