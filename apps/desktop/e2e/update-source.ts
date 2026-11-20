/**
 * 本地 HTTPS 静态更新源（M5-06/M5-07 e2e 共用）：只提供版本描述与完整安装包，
 * blockmap 返回 404 以走完整下载。自签名证书只用于本机回环地址。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nextPatchVersion } from './version.js'

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name))

export interface UpdateSourceOptions {
  /** 发布版本，默认比当前应用版本高一个补丁版本。 */
  readonly version?: string
  /** 固定端口（错误重试用例需要先失败、再在同一端口启动）；默认随机。 */
  readonly port?: number
  /** 分块发送安装包，块间停顿；用于截取下载中的进度界面。 */
  readonly throttleMs?: number
}

export interface LocalUpdateSource {
  readonly url: string
  readonly version: string
  readonly server: Server
  close(): Promise<void>
}

function sha512(data: Buffer): string {
  return createHash('sha512').update(data).digest('base64')
}

export async function startUpdateSource(
  options: UpdateSourceOptions = {},
): Promise<LocalUpdateSource> {
  const version = options.version ?? nextPatchVersion()
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
    async (incoming, response) => {
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
        if (options.throttleMs) {
          const chunk = 16 * 1024
          for (let offset = 0; offset < artifact.length; offset += chunk) {
            response.write(artifact.subarray(offset, offset + chunk))
            await new Promise((resolve) => setTimeout(resolve, options.throttleMs))
          }
        }
        response.end(options.throttleMs ? undefined : artifact)
        return
      }
      response.writeHead(404).end('not found')
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `https://127.0.0.1:${port}/`,
    version,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

/** 取一个当前空闲的回环端口，用于“先失败、后重试成功”的用例。 */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

/**
 * 开发模式（未打包）下 `electron-updater` 会读取应用目录的 `dev-app-update.yml`。
 * 返回清理函数；e2e 的 `finally` 中调用。
 */
export function useDevUpdateConfig(url: string): () => void {
  const file = path.resolve(import.meta.dirname, '..', 'dev-app-update.yml')
  // 每次用新的缓存目录：electron-updater 把它放在 userData 的上一级（系统临时目录），
  // 复用会让第二次运行直接命中缓存的安装包，跳过大半下载过程。
  const cacheDirName = `cairn-e2e-updater-${randomUUID().slice(0, 8)}`
  writeFileSync(
    file,
    ['provider: generic', `url: ${url}`, `updaterCacheDirName: ${cacheDirName}`, ''].join('\n'),
  )
  return () => {
    rmSync(file, { force: true })
    rmSync(path.join(tmpdir(), cacheDirName), { recursive: true, force: true })
  }
}
