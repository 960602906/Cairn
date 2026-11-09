/**
 * 自动更新（M5-06，ADR-0036）：用本地自签名 HTTPS 静态源验证真实 `electron-updater`
 * 的检查与下载，并确认有运行中任务（待审批）时安装被阻止。
 *
 * 自签名证书只用于本机回环地址；生产更新源必须是公开可信 HTTPS。测试不执行真实安装重启，
 * 重启提示与安装确认由 M5-07 的界面用例覆盖。
 */
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { UpdateStatus } from '@cairn/protocol'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt } from './session.js'

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name))

async function request<T>(window: Page, method: string, params: object): Promise<T> {
  const reply = (await window.evaluate(
    async ([m, p]) => {
      const cairn = (
        globalThis as unknown as { cairn: { request(m: string, p: object): Promise<unknown> } }
      ).cairn
      return cairn.request(m as string, p as object)
    },
    [method, params] as const,
  )) as { ok: boolean; result?: unknown; error?: unknown }
  if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result as T
}

async function configureProvider(window: Page, baseUrl: string): Promise<void> {
  await window.evaluate(async (url) => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    await cairn.request('settings.update', {
      providers: [
        {
          id: 'local',
          kind: 'openai',
          displayName: 'Local',
          baseUrl: url,
          models: [
            {
              id: 'e2e-model',
              contextWindow: 32_000,
              maxOutputTokens: 1_000,
              supportsTools: true,
              supportsParallelToolCalls: false,
              supportsReasoning: false,
            },
          ],
        },
      ],
      defaultModel: { providerId: 'local', modelId: 'e2e-model' },
    })
  }, baseUrl)
}

function sha512(data: Buffer): string {
  return createHash('sha512').update(data).digest('base64')
}

/** 本地 HTTPS 静态源：只提供 `latest.yml` 与完整安装包，blockmap 返回 404 以走完整下载。 */
async function updateSource(): Promise<{
  url: string
  server: Server
  close: () => Promise<void>
}> {
  const version = '0.1.1'
  const name = `Cairn Setup ${version}.exe`
  const artifact = Buffer.concat([Buffer.from('MZ fake installer\n'), Buffer.alloc(128 * 1024, 7)])
  const digest = sha512(artifact)
  const latest = [
    `version: ${version}`,
    'files:',
    `  - url: ${encodeURIComponent(name)}`,
    `    sha512: ${digest}`,
    `    size: ${artifact.length}`,
    `path: ${name}`,
    `sha512: ${digest}`,
    "releaseDate: '2026-11-10T00:00:00.000Z'",
    '',
  ].join('\n')
  const server = createServer(
    {
      key: fixture('localhost-key.pem'),
      cert: fixture('localhost-cert.pem'),
    },
    (incoming, response) => {
      const pathname = decodeURIComponent(
        new URL(incoming.url ?? '/', 'https://localhost').pathname,
      )
      if (pathname === '/latest.yml' || pathname === '/beta.yml') {
        response.writeHead(200, { 'content-type': 'text/yaml', 'cache-control': 'no-store' })
        response.end(latest)
        return
      }
      if (pathname === `/${name}`) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': artifact.length,
        })
        response.end(artifact)
        return
      }
      response.writeHead(404).end('not found')
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `https://127.0.0.1:${port}/`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

test.skip(process.platform !== 'win32', '自动更新只在 Windows 启用')

test('本地静态源：检查、下载，并在任务等待审批时阻止安装', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const source = await updateSource()
  // 开发模式（未打包）下 electron-updater 会读取 app 目录的 dev-app-update.yml。
  const devConfig = path.resolve(import.meta.dirname, '..', 'dev-app-update.yml')
  writeFileSync(
    devConfig,
    ['provider: generic', `url: ${source.url}`, 'updaterCacheDirName: cairn-e2e-updater', ''].join(
      '\n',
    ),
  )
  const mock = await startMockModel({
    reply: 'done',
    toolCall: { name: 'run_command', arguments: { command: 'echo update-busy' } },
  })
  try {
    const { window } = await launch({
      env: {
        CAIRN_UPDATE_URL: source.url,
        CAIRN_UPDATE_ALLOW_DEV: '1',
      },
      args: ['--ignore-certificate-errors'],
    })
    await configureProvider(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '更新')
    await sendPrompt(window, '运行命令')
    await expect(window.getByRole('article', { name: '需要审批：run_command' })).toBeVisible()

    await expect(request<UpdateStatus>(window, 'update.status', {})).resolves.toMatchObject({
      phase: 'idle',
      enabled: true,
      currentVersion: '0.1.0',
      channel: 'beta',
    })
    const checked = await request<UpdateStatus>(window, 'update.check', {})
    expect(checked.phase, JSON.stringify(checked)).toBe('available')
    expect(checked.availableVersion).toBe('0.1.1')
    const downloaded = await request<UpdateStatus>(window, 'update.download', {})
    expect(downloaded.phase, JSON.stringify(downloaded)).toBe('downloaded')
    expect(downloaded).toMatchObject({ requiresRestart: true, signatureVerified: false })
    await expect(request<UpdateStatus>(window, 'update.install', {})).resolves.toMatchObject({
      phase: 'downloaded',
      blockedReason: 'update.busy',
      error: { code: 'update.busy' },
    })
    await expect(window.getByRole('article', { name: '需要审批：run_command' })).toBeVisible()
  } finally {
    rmSync(devConfig, { force: true })
    await mock.close()
    await source.close()
  }
})
