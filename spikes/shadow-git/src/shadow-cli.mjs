// 基于 Git 命令行的影子仓库检查点：--git-dir 指向应用目录，--work-tree 指向工作区。
import fs from 'node:fs'
import path from 'node:path'

export const CHECKPOINT_REF = 'refs/nexus/checkpoints'

/** 精确匹配一个路径的 gitignore 规则。 */
export function exactPattern(rel) {
  return '/' + rel.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ $/, '\\ ')
}

/** `git status --porcelain=v2 -z` 中工作区存在变化的路径（已修改、新增）。 */
export function parseStatus(buf) {
  const paths = []
  for (const rec of buf.toString('utf8').split('\0')) {
    if (rec.startsWith('? ')) paths.push(rec.slice(2))
    else if (rec.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = rec.split(' ')
      const y = parts[1][1]
      if (y !== 'D') paths.push(parts.slice(8).join(' '))
    }
  }
  return paths
}

export function parseNameStatus(buf) {
  const parts = buf.toString('utf8').split('\0').filter(Boolean)
  const out = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] })
  return out
}

/**
 * 写入影子仓库的配置变体（比较写对象的方式对耗时的影响）：
 * - nofsync：不对任何对象调用 fsync；
 * - batch：fsync 按批进行（Git 2.37+）；
 * - pack：大于 1 字节的文件由 `git add` 直接写入一个包文件，而不是逐个写松散对象；
 * - pack-nofsync：pack 与 nofsync 同时使用；
 * - pack-durable：pack，包文件与引用照常 fsync，只有松散对象（此时只剩树与提交）不 fsync。
 */
export const CONFIG_VARIANTS = {
  baseline: {},
  nofsync: { 'core.fsync': 'none', 'core.fsyncObjectFiles': 'false' },
  batch: { 'core.fsync': 'loose-object,pack,index', 'core.fsyncMethod': 'batch' },
  pack: { 'core.bigFileThreshold': '1' },
  'pack-nofsync': {
    'core.bigFileThreshold': '1',
    'core.fsync': 'none',
    'core.fsyncObjectFiles': 'false',
  },
  // core.fsync 在平台默认值上增减（Git for Windows 的默认值包含 loose-object），需显式去掉。
  'pack-durable': {
    'core.bigFileThreshold': '1',
    'core.fsync': '-loose-object,pack,pack-metadata,reference',
    'core.fsyncObjectFiles': 'false',
  },
}

export function createCliShadow({
  git,
  gitDir,
  workTree,
  maxFileBytes,
  extraExcludes,
  variant = 'baseline',
}) {
  const g = (args, opts) => git.run(['--git-dir', gitDir, '--work-tree', workTree, ...args], opts)
  const text = async (args, opts) => (await g(args, opts)).stdout.toString('utf8').trim()
  const excludeFile = path.join(gitDir, 'info', 'exclude')
  let large = new Set()
  let head = null
  let headTree = null

  function writeExcludes() {
    const lines = [
      '# 额外排除规则',
      ...extraExcludes,
      '# 超过大小上限的文件',
      ...[...large].sort().map(exactPattern),
    ]
    fs.writeFileSync(excludeFile, lines.join('\n') + '\n')
  }

  function isLarge(rel) {
    try {
      const st = fs.lstatSync(path.join(workTree, ...rel.split('/')))
      return st.isFile() && st.size > maxFileBytes
    } catch {
      return false
    }
  }

  return {
    kind: 'cli',
    async init() {
      fs.rmSync(gitDir, { recursive: true, force: true })
      await git.run(['--git-dir', gitDir, 'init', '-q', '--template='])
      const config = {
        'core.bare': 'false',
        'core.autocrlf': 'false',
        'core.safecrlf': 'false',
        'core.quotePath': 'false',
        'core.longpaths': 'true',
        'core.untrackedCache': 'true',
        'core.fsmonitor': 'false',
        // Git for Windows 在系统级配置中开启；系统级配置已被屏蔽，这里显式开启（其他平台忽略）。
        'core.fscache': 'true',
        'core.excludesFile': excludeFile,
        'core.hooksPath': path.join(gitDir, 'no-hooks'),
        'gc.auto': '0',
        'maintenance.auto': 'false',
        'commit.gpgSign': 'false',
        'user.name': 'NEXUS-OS',
        'user.email': 'checkpoint@nexus.invalid',
        ...CONFIG_VARIANTS[variant],
      }
      for (const [k, v] of Object.entries(config))
        await git.run(['--git-dir', gitDir, 'config', k, v])
      fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true })
      // 优先级高于工作区中的 .gitattributes：按原样保存字节，不做换行转换，不调用 LFS 等过滤器。
      fs.writeFileSync(
        path.join(gitDir, 'info', 'attributes'),
        '* -text -eol -filter -ident -working-tree-encoding\n',
      )
      writeExcludes()
    },

    async checkpoint(message) {
      const t0 = performance.now()
      const p0 = git.processes
      const before = [...large].join('\0')
      large = new Set([...large].filter(isLarge))
      const status = await g([
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--no-renames',
      ])
      for (const rel of parseStatus(status.stdout)) if (isLarge(rel)) large.add(rel)
      let removedLarge = 0
      if ([...large].join('\0') !== before) {
        writeExcludes()
        const list = [...large].join('\0')
        if (list) {
          const rm = await g(
            [
              'rm',
              '--cached',
              '-q',
              '--ignore-unmatch',
              '--pathspec-from-file=-',
              '--pathspec-file-nul',
            ],
            { stdin: list },
          )
          removedLarge = rm.code === 0 ? large.size : 0
        }
      }
      const tScan = performance.now()
      const add = await g(['add', '-A', '--ignore-errors'], { allowFail: true })
      const tAdd = performance.now()
      const tree = await text(['write-tree'])
      let created = false
      if (tree !== headTree) {
        const args = ['commit-tree', tree, '-m', message]
        if (head) args.push('-p', head)
        const commit = await text(args)
        await g(['update-ref', CHECKPOINT_REF, commit, ...(head ? [head] : [])])
        head = commit
        headTree = tree
        created = true
      }
      const t1 = performance.now()
      return {
        commit: head,
        created,
        large: [...large],
        removedLarge,
        addWarnings: add.code === 0 ? '' : add.stderr.trim(),
        processes: git.processes - p0,
        ms: { scan: tScan - t0, add: tAdd - tScan, commit: t1 - tAdd, total: t1 - t0 },
      }
    },

    async diff(from, to) {
      return parseNameStatus(
        (await g(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to])).stdout,
      )
    },

    async restore(commit) {
      const t0 = performance.now()
      const pre = await this.checkpoint(`before restore to ${commit}`)
      const tCp = performance.now()
      const changes = await this.diff(pre.commit, commit)
      const tDiff = performance.now()
      // 索引此时与 pre 一致：read-tree 只改写有差异的文件，并删除 pre 中有而目标中没有的文件。
      await g(['read-tree', '-u', '--reset', commit])
      const t1 = performance.now()
      return {
        before: pre.commit,
        changes,
        ms: { checkpoint: tCp - t0, diff: tDiff - tCp, apply: t1 - tDiff, total: t1 - t0 },
      }
    },

    /** 检查点中的全部条目：{ mode, path }，嵌套仓库为 160000（gitlink）。 */
    async entries(commit) {
      const out = (await g(['ls-tree', '-r', '-z', '--full-tree', commit])).stdout.toString('utf8')
      return out
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t')
          return { mode: line.slice(0, 6), path: line.slice(tab + 1) }
        })
    },

    async gc() {
      const t0 = performance.now()
      await g(['gc', '--quiet', '--prune=now'])
      return performance.now() - t0
    },
  }
}
