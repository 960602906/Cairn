// @ts-check
/**
 * electron-builder `afterPack` 钩子（M5-10）。
 *
 * `--publish never` 会跳过 `app-update.yml` 的生成，但 `electron-updater` 在下载更新时仍会读取
 * 这个文件（提供者与缓存目录）。缺少它时，安装版 `update.download` 会以
 * `ENOENT ... app-update.yml` 失败。这里按构建时注入的更新源补写该文件：
 * - 发布构建使用 `CAIRN_UPDATE_URL`（与 `build-info` 的来源一致）；
 * - 本地打包使用与 `electron-builder.yml` 相同的占位源，运行时仍可由 `CAIRN_UPDATE_URL` 覆盖。
 */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder 用 require 加载 afterPack 钩子 */
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
/* eslint-enable @typescript-eslint/no-require-imports */

/** 与 `electron-builder.yml` 的 `publish` 配置保持一致。 */
const DEFAULT_UPDATE_URL = 'https://updates.invalid/cairn/'

/**
 * 生成 `app-update.yml` 内容。
 * @param {string} [rawUrl]
 * @returns {string}
 */
function appUpdateConfig(rawUrl = DEFAULT_UPDATE_URL) {
  const trimmed = rawUrl.trim()
  const base = trimmed === '' ? DEFAULT_UPDATE_URL : trimmed
  return [
    'provider: generic',
    `url: ${base.replace(/\/+$/, '')}/`,
    'updaterCacheDirName: cairn-updater',
    '',
  ].join('\n')
}

/**
 * @param {{ appOutDir: string }} context
 * @returns {Promise<void>}
 */
async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(
    path.join(resources, 'app-update.yml'),
    appUpdateConfig(process.env['CAIRN_UPDATE_URL']),
  )
}

module.exports = afterPack
module.exports.appUpdateConfig = appUpdateConfig
module.exports.DEFAULT_UPDATE_URL = DEFAULT_UPDATE_URL
