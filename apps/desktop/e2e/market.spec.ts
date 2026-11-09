/**
 * 资源市场（M5）：在主进程替换 fetch，返回一条 ClawHub 技能卡片和一份 zip，
 * 验证“市场 → 下载并安装 → 已安装列表”的完整链路，不依赖外网。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test } from './app.js'

const requireFromSkills = createRequire(
  path.resolve(import.meta.dirname, '../../../packages/skills/package.json'),
)
const { strToU8, zipSync } = requireFromSkills('fflate') as {
  strToU8: (text: string) => Uint8Array
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array
}

test('从技能市场下载并安装', async ({ launch }) => {
  const { app, window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const markdown = '---\nname: market-demo\ndescription: From the market.\n---\nBody.\n'
  const zip = zipSync({ 'market-demo/SKILL.md': strToU8(markdown) })

  await app.evaluate(
    (_electron, payload) => {
      const original = globalThis.fetch
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/v1/skills') || url.includes('/api/v1/search')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  slug: 'market-demo',
                  displayName: 'Market Demo',
                  summary: 'Installed from the marketplace.',
                  owner: { handle: 'cairn' },
                  stats: { downloads: 123, stars: 9 },
                  latestVersion: { version: '1.0.0' },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/api/v1/download')) {
          return new Response(new Uint8Array(payload.bytes), { status: 200 })
        }
        return original(input, init)
      }) as typeof fetch
    },
    { bytes: [...zip] },
  )

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^技能/ }).click()
  await window.getByRole('tab', { name: '市场' }).click()

  const market = window.getByRole('list', { name: '技能市场' })
  await expect(market.getByText('Market Demo')).toBeVisible()
  await expect(market.getByText('@cairn · v1.0.0')).toBeVisible()
  await market.getByRole('button', { name: '下载并安装' }).click()

  await expect(window.getByRole('tab', { name: '已安装' })).toHaveAttribute('aria-selected', 'true')
  const installed = window.getByRole('list', { name: '技能' })
  await expect(installed.getByText('market-demo')).toBeVisible()
  await expect(installed.getByText('From the market.')).toBeVisible()
})
