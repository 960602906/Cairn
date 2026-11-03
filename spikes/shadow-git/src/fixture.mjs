// 生成固定种子的测试工作区：约 1 万个应被快照的文件，加上各种应被排除或需特别处理的情况。
import fs from 'node:fs'
import path from 'node:path'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const IS_WINDOWS = process.platform === 'win32'

export function createRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'const let function return import export from async await if else for while switch case ' +
  'break default class extends new this null undefined true false typeof interface type ' +
  'session run turn step message event payload state error result value options config ' +
  'checkpoint restore workspace project path file index tree commit stream delta tool'
).split(' ')

/** 类似源码的文本：可压缩程度接近真实代码。 */
export function textContent(rng, bytes, eol = '\n') {
  const lines = []
  let size = 0
  while (size < bytes) {
    const indent = ' '.repeat(Math.floor(rng() * 4) * 2)
    const n = 3 + Math.floor(rng() * 9)
    const words = []
    for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(rng() * WORDS.length)])
    const line = `${indent}${words.join(' ')};`
    lines.push(line)
    size += line.length + eol.length
  }
  return lines.join(eol) + eol
}

export function binaryContent(rng, bytes) {
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(rng() * 256)
  return buf
}

/** 文件大小分布：70% 0.5～4 KB，25% 4～32 KB，5% 32～256 KB。 */
export function sampleSize(rng) {
  const r = rng()
  const [lo, hi] = r < 0.7 ? [512, 4096] : r < 0.95 ? [4096, 32768] : [32768, 262144]
  return Math.floor(lo + rng() * (hi - lo))
}

const EXTENSIONS = ['ts', 'ts', 'ts', 'tsx', 'json', 'md', 'css', 'js']

export function write(ws, rel, content, mode) {
  const file = path.join(ws, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode !== undefined && !IS_WINDOWS) fs.chmodSync(file, mode)
}

/**
 * 应被快照的路径（工作区相对路径，`/` 分隔）。规则与 fixture 中的 `.gitignore`、
 * 影子仓库的额外排除规则和大小上限一一对应，用于独立校验快照内容。
 */
export function isTracked(rel, sizeOf) {
  if (rel === '.git' || rel.startsWith('.git/')) return false
  if (rel.split('/').includes('node_modules')) return false
  if (rel.startsWith('dist/')) return false
  if (rel.endsWith('.log')) return false
  if (rel.startsWith('packages/p0/generated/')) return false
  if (NESTED_REPOS.some((repo) => rel.startsWith(`${repo}/`))) return false
  if (sizeOf(rel) > MAX_FILE_BYTES) return false
  return true
}

/** 工作区中的嵌套仓库：处理方式因 Git 来源而异，单独记录，不计入快照内容的校验。 */
export const NESTED_REPOS = ['vendor/lib', 'vendor/unborn']

/** 影子仓库在项目 `.gitignore` 之外追加的排除规则。 */
export const EXTRA_EXCLUDES = ['node_modules/']

/**
 * 在 ws 下生成工作区。`git(args, cwd)` 用于为工作区创建用户自己的仓库与嵌套仓库。
 * 返回各类特殊路径，供检查使用。
 */
export async function generateWorkspace(ws, { files = 10000, seed = 20261103, git }) {
  const rng = createRng(seed)
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })

  write(ws, '.gitignore', 'dist/\n*.log\n')
  write(ws, '.gitattributes', '*.txt text eol=crlf\n*.dat filter=lfs diff=lfs merge=lfs -text\n')
  write(ws, 'README.md', '# fixture\n')
  write(ws, 'package.json', '{ "name": "fixture", "private": true }\n')
  write(ws, 'packages/p0/.gitignore', 'generated/\n')

  const special = {
    chinese: 'docs/中文 文件名.md',
    punct: 'docs/with space & #hash[1]!.md',
    crlf: 'crlf/windows.txt',
    lfText: 'crlf/lf-but-attr-crlf.txt',
    lfs: 'lfs/asset.dat',
    exec: 'scripts/run.sh',
    symlink: IS_WINDOWS ? null : 'link-to-readme',
    huge: 'assets/huge.bin',
    nested: 'vendor/lib/inner.ts',
  }
  write(ws, special.chinese, '中文内容\n')
  write(ws, special.punct, 'punctuation\n')
  write(ws, special.crlf, textContent(rng, 2000, '\r\n'))
  write(ws, special.lfText, textContent(rng, 2000, '\n'))
  write(ws, special.lfs, binaryContent(rng, 4096))
  write(ws, special.exec, '#!/bin/sh\necho ok\n', 0o755)
  if (special.symlink) fs.symlinkSync('README.md', path.join(ws, special.symlink))
  write(ws, special.huge, binaryContent(rng, 24 * 1024 * 1024))

  let tracked = 0
  const countSpecial = 9 + (special.symlink ? 1 : 0)
  const target = files - countSpecial
  for (let i = 0; i < target; i++) {
    const pkg = i % 20
    const dir = `packages/p${pkg}/src/${String.fromCharCode(97 + ((i >> 3) % 6))}/${(i >> 6) % 8}`
    const ext = EXTENSIONS[i % EXTENSIONS.length]
    write(ws, `${dir}/f${i}.${ext}`, textContent(rng, sampleSize(rng)))
    tracked++
  }

  for (let i = 0; i < 3000; i++) {
    write(ws, `node_modules/pkg-${i % 300}/lib/m${i}.js`, textContent(rng, 600))
  }
  for (let i = 0; i < 200; i++) {
    write(ws, `packages/p0/node_modules/dep-${i % 20}/i${i}.js`, textContent(rng, 400))
  }
  for (let i = 0; i < 300; i++) write(ws, `dist/chunk-${i}.js`, textContent(rng, 2000))
  for (let i = 0; i < 50; i++) write(ws, `packages/p0/generated/g${i}.ts`, textContent(rng, 800))
  write(ws, 'logs/app.log', textContent(rng, 5000))
  write(ws, 'debug.log', textContent(rng, 1000))

  // 用户自己的仓库：只提交少量文件，检查影子仓库不读写它。
  await git(['init', '-q'], ws)
  await git(['add', 'README.md', 'package.json'], ws)
  await git(
    ['-c', 'user.name=u', '-c', 'user.email=u@example.com', 'commit', '-q', '-m', 'user'],
    ws,
  )

  // 嵌套仓库：有提交的（如克隆到 vendor/ 下的依赖）与刚 init、还没有提交的。
  for (let i = 0; i < 20; i++) write(ws, `vendor/lib/f${i}.ts`, textContent(rng, 1000))
  write(ws, special.nested, 'export const inner = 1;\n')
  const lib = path.join(ws, 'vendor/lib')
  await git(['init', '-q'], lib)
  await git(['add', '-A'], lib)
  await git(
    ['-c', 'user.name=u', '-c', 'user.email=u@example.com', 'commit', '-q', '-m', 'lib'],
    lib,
  )
  for (let i = 0; i < 5; i++) write(ws, `vendor/unborn/f${i}.ts`, textContent(rng, 1000))
  await git(['init', '-q'], path.join(ws, 'vendor/unborn'))

  return { special, generated: tracked + countSpecial }
}
