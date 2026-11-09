// @ts-check
/**
 * M5-00 S2：检查 electron-builder 产物（app.asar、asarUnpack、资源、NSIS 与 blockmap）。
 *
 * 用法：node src/check-package.mjs [win-unpacked 目录] [安装包目录]
 * 默认检查 `out/s2/win-unpacked` 与 `out/s2`。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import asar from '@electron/asar'

const root = path.resolve(import.meta.dirname, '..')
const unpacked = path.resolve(process.argv[2] ?? path.join(root, 'out/s2/win-unpacked'))
const installers = path.resolve(process.argv[3] ?? path.join(root, 'out/s2'))
const appAsar = path.join(unpacked, 'resources/app.asar')
const unpackedRoot = path.join(unpacked, 'resources/app.asar.unpacked')
const problems = []
const warnings = []

/** @param {string} file @param {string} label */
function requireFile(file, label) {
  if (!existsSync(file)) problems.push(`missing ${label}: ${file}`)
}

requireFile(path.join(unpacked, 'Cairn.exe'), 'main executable')
requireFile(appAsar, 'app.asar')
requireFile(path.join(unpacked, 'resources/skills/example/SKILL.md'), 'resources/skills')

if (existsSync(appAsar)) {
  const entries = new Set(asar.listPackage(appAsar))
  for (const entry of [
    '\\out\\main\\index.js',
    '\\out\\main\\agent-host.js',
    '\\out\\preload\\index.cjs',
    '\\out\\renderer\\index.html',
    '\\out\\bin\\rg.exe',
    '\\out\\THIRD_PARTY_NOTICES.txt',
    '\\package.json',
  ]) {
    if (!entries.has(entry)) problems.push(`app.asar missing ${entry}`)
  }
  const nodeModules = [...entries].filter((entry) => entry.startsWith('\\node_modules\\')).length
  const bytes = statSync(appAsar).size
  if (bytes > 30 * 1024 * 1024) {
    warnings.push(
      `app.asar is ${(bytes / 1e6).toFixed(1)} MB with ${nodeModules} node_modules entries; ` +
        'use a production deployment instead of the workspace node_modules (M5-02).',
    )
  }
}

/** @param {string} dir @param {RegExp} pattern */
function findFiles(dir, pattern) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
}

const nativeModules = [
  ['koffi', findFiles(path.join(unpackedRoot, 'node_modules/@koromix'), /\.node$/i)],
  ['better-sqlite3', findFiles(path.join(unpackedRoot, 'node_modules/better-sqlite3'), /\.node$/i)],
  ['ripgrep', findFiles(path.join(unpackedRoot, 'out/bin'), /^rg\.exe$/i)],
]
for (const [name, files] of nativeModules) {
  if (files.length === 0) problems.push(`asarUnpack missing ${name}`)
}

const installer = readdirSync(installers).find(
  (name) => name.endsWith('.exe') && name.includes('Setup'),
)
if (!installer) problems.push('NSIS installer not found')
else {
  const file = path.join(installers, installer)
  const blockmap = `${file}.blockmap`
  if (!existsSync(blockmap)) problems.push(`blockmap missing for ${installer}`)
  console.log(`installer: ${installer} (${(statSync(file).size / 1e6).toFixed(1)} MB)`)
}

if (existsSync(path.join(installers, 'builder-effective-config.yaml'))) {
  const config = readFileSync(path.join(installers, 'builder-effective-config.yaml'), 'utf8')
  if (/publish:\s*\n\s*provider:\s*github/i.test(config) && /token/i.test(config)) {
    problems.push('effective config appears to contain publishing credentials')
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`)
  process.exit(1)
}
console.log(`package check passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`)
