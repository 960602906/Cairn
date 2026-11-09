// @ts-check
/**
 * M5-00 S2：用“扁平生产依赖”目录复现 electron-builder 打包。
 *
 * 直接把 `apps/desktop` 交给 electron-builder 会把 pnpm 工作区的
 * `node_modules` 链接与虚拟 store 一起带进 app.asar。本脚本先把构建产物、
 * 资源与仅含外部生产依赖的 package.json 复制到独立目录，在该目录执行 npm
 * 安装，再生成 `--dir` 与 NSIS 产物。
 *
 * 运行：`node src/s2-package.mjs`（先确保 `apps/desktop/out` 已构建）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const spikeRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(spikeRoot, '../..')
const desktopRoot = path.join(repoRoot, 'apps/desktop')
const stage = path.join(spikeRoot, 'work/s2-app')
const output = path.join(spikeRoot, 'out/s2')
const builder = path.join(
  spikeRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
)

if (!existsSync(path.join(desktopRoot, 'out/main/index.js'))) {
  throw new Error('apps/desktop/out is missing; run `pnpm build` first')
}

rmSync(stage, { recursive: true, force: true })
rmSync(output, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(path.join(desktopRoot, 'out'), path.join(stage, 'out'), { recursive: true })
cpSync(path.join(desktopRoot, 'resources'), path.join(stage, 'resources'), { recursive: true })

const desktopPackage = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
// 主进程与工作区包在运行时直接 require 的外部依赖。渲染进程依赖已被 Vite 打进
// renderer 产物，@vscode/ripgrep 也已复制为 out/bin/rg.exe，不需要再随 node_modules 分发。
// M5-02 应以构建产物的实际 import 自动校验这份清单，而不是长期手工维护。
const runtimeDependencies = new Set([
  'better-sqlite3',
  'koffi',
  'yaml',
  'fflate',
  'diff',
  'zod',
  'i18next',
])
const dependencies = Object.fromEntries(
  Object.entries(desktopPackage.dependencies).filter(([name]) => runtimeDependencies.has(name)),
)
writeFileSync(
  path.join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: desktopPackage.name,
      version: desktopPackage.version,
      private: true,
      type: desktopPackage.type,
      main: desktopPackage.main,
      description: 'Cairn desktop packaged application',
      author: 'Cairn',
      dependencies,
      devDependencies: { electron: desktopPackage.devDependencies.electron },
    },
    null,
    2,
  )}\n`,
)

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env = process.env) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: stage,
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with ${result.status}`)
}

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'install',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--registry=https://registry.npmjs.org/',
])

const builderEnv = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}
run(
  builder,
  [
    '--projectDir',
    stage,
    '--config',
    path.join(spikeRoot, 'electron-builder.spike.yml'),
    '--dir',
    '--config.directories.output',
    output,
  ],
  builderEnv,
)
run(
  builder,
  [
    '--projectDir',
    stage,
    '--config',
    path.join(spikeRoot, 'electron-builder.spike.yml'),
    '--win',
    'nsis',
    '--config.directories.output',
    output,
  ],
  builderEnv,
)
run(process.execPath, [
  path.join(spikeRoot, 'src/check-package.mjs'),
  path.join(output, 'win-unpacked'),
  output,
])
