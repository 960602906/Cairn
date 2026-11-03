// 对一种 Git 来源执行完整的检查点流程，记录耗时并独立校验每次快照与恢复的结果。
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  EXTRA_EXCLUDES,
  IS_WINDOWS,
  MAX_FILE_BYTES,
  NESTED_REPOS,
  binaryContent,
  createRng,
  generateWorkspace,
  isTracked,
  textContent,
  write,
} from './fixture.mjs'
import { bundledGit, systemGit } from './git-runner.mjs'
import { diffManifest, dirStats, emptyDirs, manifest, sizeOf } from './manifest.mjs'
import { createCliShadow } from './shadow-cli.mjs'
import { createIsoShadow } from './shadow-iso.mjs'

export const SOURCES = ['system', 'bundled', 'isogit']

const require = createRequire(import.meta.url)

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN
}

async function spawnOverhead(git) {
  const ms = []
  for (let i = 0; i < 10; i++) ms.push((await git.run(['--version'])).ms)
  return median(ms)
}

/** Git 来源本身的信息：版本、进程启动开销、随应用分发的体积。 */
async function describeSource(source, stateDir) {
  if (source === 'isogit') {
    const pkg = path.dirname(require.resolve('isomorphic-git'))
    const { version } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
    return { version, install: dirStats(pkg) }
  }
  const git = source === 'system' ? systemGit(stateDir) : await bundledGit(stateDir)
  const version = await git.text(['--version'])
  const info = { version, binary: git.binary, spawnMs: await spawnOverhead(git) }
  if (source === 'bundled') {
    const { resolveGitDir } = await import('dugite')
    info.install = dirStats(resolveGitDir())
  }
  return info
}

/** spec 为 `<来源>` 或 `<来源>:<配置变体>`（见 shadow-cli.mjs 的 CONFIG_VARIANTS）。 */
export async function runBench({
  spec,
  root,
  files = 10000,
  smallRounds = 5,
  restoreRounds = 3,
  log = () => {},
}) {
  const [source, variant = 'baseline'] = spec.split(':')
  const id = spec.replace(':', '-')
  const ws = path.join(root, `ws-${id}`)
  const gitDir = path.join(root, `shadow-${id}`)
  const stateDir = path.join(root, `state-${id}`)
  const result = {
    source,
    variant,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    files,
    maxFileBytes: MAX_FILE_BYTES,
    sourceInfo: null,
    steps: {},
    checks: [],
    info: {},
    ok: false,
  }
  const step = (name, value) => {
    result.steps[name] = value
    log(`${name}: ${JSON.stringify(value.ms ?? value)}`)
  }
  const check = (name, ok, detail) => {
    result.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
    if (!ok) log(`CHECK FAILED ${name}: ${JSON.stringify(detail)}`)
  }

  try {
    result.sourceInfo = await describeSource(source, stateDir)
    log(`source ${source}: ${JSON.stringify(result.sourceInfo)}`)

    // 工作区中的用户仓库与嵌套仓库统一用打包的 Git 创建，与被测来源无关。
    const fixtureGit = await bundledGit(path.join(stateDir, 'fixture'))
    const tGen = performance.now()
    const { special, generated } = await generateWorkspace(ws, {
      files,
      git: (args, cwd) => fixtureGit.run(args, { cwd }),
    })
    step('fixture', { ms: { total: performance.now() - tGen }, generated })

    const sz = sizeOf(ws)
    const tracked = (rel) => isTracked(rel, sz)
    const ignored = (rel) => !rel.startsWith('.git/') && !isTracked(rel, sz)
    const userGit = (rel) => rel.startsWith('.git/')
    const userGitBefore = manifest(ws, userGit)

    const opts = {
      gitDir,
      workTree: ws,
      maxFileBytes: MAX_FILE_BYTES,
      extraExcludes: EXTRA_EXCLUDES,
    }
    const shadow =
      source === 'isogit'
        ? createIsoShadow(opts)
        : createCliShadow({
            ...opts,
            git: source === 'system' ? systemGit(stateDir) : await bundledGit(stateDir),
            variant,
          })

    const tInit = performance.now()
    await shadow.init()
    step('init', { ms: { total: performance.now() - tInit } })

    const coverage = async (name, commit, expected) => {
      const entries = await shadow.entries(commit)
      const blobs = new Set(
        entries
          .filter(
            (e) => e.mode !== '160000' && !NESTED_REPOS.some((r) => e.path.startsWith(`${r}/`)),
          )
          .map((e) => e.path),
      )
      const diff = diffManifest(
        new Map([...expected.keys()].map((k) => [k, 1])),
        new Map([...blobs].map((k) => [k, 1])),
      )
      check(name, diff.length === 0, diff.length ? diff : undefined)
      return entries
    }

    // 1. 首次检查点
    const cp1 = await shadow.checkpoint('initial')
    step('checkpoint.initial', cp1)
    const m1 = manifest(ws, tracked)
    result.info.trackedFiles = m1.size
    const entries1 = await coverage('coverage.initial', cp1.commit, m1)
    // 嵌套仓库：gitlink（只记录提交 id）、files（内容当作普通文件）或 none（完全没有记录）。
    result.info.nestedRepos = Object.fromEntries(
      NESTED_REPOS.map((repo) => {
        const own = entries1.filter((e) => e.path === repo || e.path.startsWith(`${repo}/`))
        const kind = own.some((e) => e.mode === '160000')
          ? 'gitlink'
          : own.length
            ? `files(${own.length})`
            : 'none'
        return [repo, own.some((e) => e.path.startsWith(`${repo}/.git/`)) ? `${kind}+.git` : kind]
      }),
    )
    result.info.addWarnings = cp1.addWarnings ?? ''
    check('large file skipped', cp1.large.includes(special.huge), cp1.large)
    check(
      'symlink stored as link',
      !special.symlink || entries1.some((e) => e.path === special.symlink && e.mode === '120000'),
    )
    check(
      'exec bit stored',
      IS_WINDOWS || entries1.some((e) => e.path === special.exec && e.mode === '100755'),
    )

    // 2. 没有改动
    const cpNo = await shadow.checkpoint('no change')
    step('checkpoint.nochange', cpNo)
    check('no-change checkpoint reuses commit', !cpNo.created && cpNo.commit === cp1.commit)

    // 3. 小改动（一轮对话常见的规模）
    const rng = createRng(7)
    const pool = [...m1.keys()].filter((p) => p.startsWith('packages/')).sort()
    const pick = () => pool[Math.floor(rng() * pool.length)]
    const small = []
    for (let r = 0; r < smallRounds; r++) {
      for (let i = 0; i < 20; i++) write(ws, pick(), textContent(rng, 3000))
      for (let i = 0; i < 5; i++)
        write(ws, `packages/p3/src/new/r${r}-${i}.ts`, textContent(rng, 2000))
      for (let i = 0; i < 5; i++) fs.rmSync(path.join(ws, pick()), { force: true })
      const cp = await shadow.checkpoint(`small ${r}`)
      small.push(cp)
      check(`small checkpoint ${r} created`, cp.created)
    }
    step('checkpoint.small', {
      ms: Object.fromEntries(
        Object.keys(small[0].ms).map((k) => [k, median(small.map((c) => c.ms[k]))]),
      ),
      maxTotal: Math.max(...small.map((c) => c.ms.total)),
      processes: small[0].processes,
    })
    const mSmall = manifest(ws, tracked)
    await coverage('coverage.small', small.at(-1).commit, mSmall)

    // 4. 只改修改时间（格式化工具、切换分支后常见）：必须重新读取所有文件，但内容不变
    const now = new Date()
    for (const rel of mSmall.keys()) {
      const file = path.join(ws, ...rel.split('/'))
      if (!fs.lstatSync(file).isSymbolicLink()) fs.utimesSync(file, now, now)
    }
    const cpTouch = await shadow.checkpoint('touch all')
    step('checkpoint.touchAll', cpTouch)
    check('touch-all checkpoint reuses commit', !cpTouch.created)

    // 5. 大改动（代码生成器、批量格式化、包管理器的规模）
    const largeRng = createRng(11)
    const files2 = [...mSmall.keys()]
      .filter((p) => p.startsWith('packages/') && !p.startsWith('packages/p1/src/b/'))
      .sort()
    for (let i = files2.length - 1; i > 0; i--) {
      const j = Math.floor(largeRng() * (i + 1))
      ;[files2[i], files2[j]] = [files2[j], files2[i]]
    }
    const nModify = Math.round(files * 0.1)
    const nChurn = Math.round(files * 0.05)
    for (const rel of files2.slice(0, nModify)) write(ws, rel, textContent(largeRng, 4000))
    const wholeDir = [...mSmall.keys()].filter((p) => p.startsWith('packages/p1/src/b/'))
    fs.rmSync(path.join(ws, 'packages/p1/src/b'), { recursive: true, force: true })
    for (const rel of files2.slice(nModify, nModify + Math.max(0, nChurn - wholeDir.length))) {
      fs.rmSync(path.join(ws, ...rel.split('/')), { force: true })
    }
    for (let i = 0; i < nChurn; i++)
      write(ws, `packages/codegen/x${i % 25}/out${i}.ts`, textContent(largeRng, 3000))
    write(ws, 'dist/chunk-0.js', 'changed dist\n')
    write(ws, 'node_modules/pkg-0/lib/m0.js', 'changed node_modules\n')
    write(ws, 'logs/app.log', 'changed log\n')
    write(ws, 'assets/new-huge.bin', binaryContent(largeRng, 12 * 1024 * 1024))
    if (!IS_WINDOWS) fs.chmodSync(path.join(ws, ...files2[0].split('/')), 0o755)
    const cp3 = await shadow.checkpoint('large')
    step('checkpoint.large', cp3)
    result.info.largeChange = {
      modified: nModify,
      deleted: Math.max(nChurn, wholeDir.length),
      added: nChurn,
    }
    check('new large file skipped', cp3.large.includes('assets/new-huge.bin'), cp3.large)
    const m3 = manifest(ws, tracked)
    await coverage('coverage.large', cp3.commit, m3)

    // 6. 恢复到首次检查点，再撤销恢复；重复几轮
    const restores = []
    const undos = []
    for (let r = 0; r < restoreRounds; r++) {
      const ignoredBefore = manifest(ws, ignored)
      const res = await shadow.restore(cp1.commit)
      restores.push(res)
      check(
        `restore ${r}: tracked files match initial`,
        diffManifest(m1, manifest(ws, tracked)).length === 0,
        diffManifest(m1, manifest(ws, tracked)),
      )
      check(
        `restore ${r}: ignored files untouched`,
        diffManifest(ignoredBefore, manifest(ws, ignored)).length === 0,
        diffManifest(ignoredBefore, manifest(ws, ignored)),
      )
      if (r === 0) {
        const read = (rel) => fs.readFileSync(path.join(ws, ...rel.split('/')))
        check('crlf kept', read(special.crlf).includes('\r\n'))
        check('lf kept despite eol=crlf attribute', !read(special.lfText).includes('\r'))
        check(
          'chinese file name restored',
          fs.existsSync(path.join(ws, ...special.chinese.split('/'))),
        )
        check('deleted directory restored', fs.existsSync(path.join(ws, 'packages/p1/src/b')))
        check('added directories removed', !fs.existsSync(path.join(ws, 'packages/codegen')))
        check(
          'symlink restored',
          !special.symlink || fs.lstatSync(path.join(ws, special.symlink)).isSymbolicLink(),
        )
        result.info.emptyDirsAfterRestore = emptyDirs(ws).filter(
          (d) => !d.startsWith('.git/') && !d.includes('/.git/'),
        )
        result.info.restoreChanges = res.changes.length
      }
      const undo = await shadow.restore(res.before)
      undos.push(undo)
      check(
        `undo ${r}: tracked files match pre-restore`,
        diffManifest(m3, manifest(ws, tracked)).length === 0,
        diffManifest(m3, manifest(ws, tracked)),
      )
    }
    const summarize = (list) => ({
      ms: Object.fromEntries(
        Object.keys(list[0].ms).map((k) => [k, median(list.map((x) => x.ms[k]))]),
      ),
      maxTotal: Math.max(...list.map((x) => x.ms.total)),
      changes: list[0].changes.length,
    })
    step('restore.toInitial', summarize(restores))
    step('restore.undo', summarize(undos))

    check(
      'user .git untouched',
      diffManifest(userGitBefore, manifest(ws, userGit)).length === 0,
      diffManifest(userGitBefore, manifest(ws, userGit)),
    )

    // 7. 影子仓库体积与整理
    result.info.shadowBefore = dirStats(gitDir)
    const gcMs = await shadow.gc()
    if (gcMs !== null) {
      result.info.gcMs = gcMs
      result.info.shadowAfterGc = dirStats(gitDir)
    }
    result.ok = result.checks.every((c) => c.ok)
  } catch (err) {
    result.error = String(err?.stack ?? err)
    log(result.error)
  }
  for (const dir of [ws, gitDir, stateDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (err) {
      log(`cleanup failed: ${err.message}`)
    }
  }
  return result
}
