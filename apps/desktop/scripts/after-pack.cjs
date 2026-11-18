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

/** `https://github.com/<owner>/<repo>`：公开仓库的 GitHub Releases 更新源。 */
const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i

/**
 * 生成 `app-update.yml` 内容。
 *
 * 运行时 `update-service` 会用 `setFeedURL` 覆盖提供者，这个文件仍必须存在：
 * `electron-updater` 从它读取 `updaterCacheDirName`。GitHub 仓库地址写成 `provider: github`，
 * 与运行时的 GitHub provider 保持一致，避免诊断时出现两套说法。
 * @param {string} [rawUrl]
 * @returns {string}
 */
function appUpdateConfig(rawUrl = DEFAULT_UPDATE_URL) {
  const trimmed = rawUrl.trim()
  const base = trimmed === '' ? DEFAULT_UPDATE_URL : trimmed
  /** @type {string[]} */
  const lines = []
  const github = GITHUB_REPO_PATTERN.exec(base)
  if (github?.[1] && github[2]) {
    lines.push('provider: github', `owner: ${github[1]}`, `repo: ${github[2]}`)
  } else {
    lines.push('provider: generic', `url: ${base.replace(/\/+$/, '')}/`)
  }
  lines.push('updaterCacheDirName: cairn-updater', '')
  return lines.join('\n')
}

/**
 * 产物里的 `Resources` 目录：macOS 在 `Cairn.app/Contents/Resources`，其他平台在 `<appOutDir>/resources`。
 * @param {{ appOutDir: string; packager?: { platform?: { name?: string }; appInfo?: { productFilename?: string } } }} context
 * @returns {string}
 */
function resourcesDirectory(context) {
  if (context.packager?.platform?.name === 'mac') {
    const app = context.packager.appInfo?.productFilename ?? 'Cairn'
    return path.join(context.appOutDir, `${app}.app`, 'Contents', 'Resources')
  }
  return path.join(context.appOutDir, 'resources')
}

/**
 * @param {{ appOutDir: string; packager?: { platform?: { name?: string }; appInfo?: { productFilename?: string } } }} context
 * @returns {Promise<void>}
 */
async function afterPack(context) {
  const resources = resourcesDirectory(context)
  mkdirSync(resources, { recursive: true })
  writeFileSync(
    path.join(resources, 'app-update.yml'),
    appUpdateConfig(process.env['CAIRN_UPDATE_URL']),
  )
}

module.exports = afterPack
module.exports.appUpdateConfig = appUpdateConfig
module.exports.resourcesDirectory = resourcesDirectory
module.exports.DEFAULT_UPDATE_URL = DEFAULT_UPDATE_URL
