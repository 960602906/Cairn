/**
 * 凭据 IPC（M1-03b / ADR-0051）：渲染进程只能写入、删除和查询是否已配置（与末 4 位），任何返回值
 * 都不含明文；保存的文件中也没有明文。各平台（含无密钥环的 Linux CI）均可保存。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'

const SECRET = 'cairn-e2e-secret-value-0123456789'

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string } }

test('渲染进程可以保存与查询凭据，但读不到明文', async ({ launch, userData }) => {
  const { window } = await launch()
  const call = (method: string, params: object) =>
    window.evaluate(
      async ([m, p]) => {
        const cairn = (
          globalThis as unknown as {
            cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
          }
        ).cairn
        await cairn.ready()
        return cairn.request(m, p)
      },
      [method, params] as const,
    ) as Promise<Reply>

  const replies: Reply[] = []
  const send = async (method: string, params: object) => {
    const reply = await call(method, params)
    replies.push(reply)
    return reply
  }

  expect(await send('credentials.status', { ref: 'deepseek' })).toEqual({
    ok: true,
    result: { configured: false, available: true },
  })

  expect(await send('credentials.set', { ref: 'deepseek', secret: SECRET })).toEqual({
    ok: true,
    result: {},
  })
  expect(await send('credentials.status', { ref: 'deepseek' })).toEqual({
    ok: true,
    // 只给出末 4 位（M2-10），用于界面显示
    result: { configured: true, available: true, last4: SECRET.slice(-4) },
  })
  const file = path.join(userData, 'credentials.json')
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
  expect(await send('credentials.delete', { ref: 'deepseek' })).toEqual({
    ok: true,
    result: { deleted: true },
  })
  expect(await send('credentials.status', { ref: 'deepseek' })).toEqual({
    ok: true,
    result: { configured: false, available: true },
  })

  // 不存在读取明文的方法
  const read = await send('credentials.get', { ref: 'deepseek' })
  expect(read.ok).toBe(false)
  expect(JSON.stringify(replies)).not.toContain(SECRET)
})
