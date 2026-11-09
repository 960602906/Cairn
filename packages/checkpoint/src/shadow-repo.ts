/**
 * 影子仓库检查点（M1-12a，ADR-0008，架构 §11，按 S5 的做法：`spikes/shadow-git/README.md`）。
 *
 * - 每个项目一个影子仓库，放在应用数据目录：`--git-dir` 指向影子仓库，`--work-tree` 指向工作区，
 *   不触碰用户自己的 `.git`。检查点是 `refs/cairn/checkpoints` 上的一条提交链，提交 id 即检查点 id。
 * - 与用户环境隔离（`git.ts`）；仓库自己的设置写在 `cairn.gitconfig`（经 `include.path` 引入，每次
 *   打开时重写）：不换行转换、不运行钩子、不签名、不自动 gc；`core.bigFileThreshold=1` 让 `git add`
 *   直接写包文件，`core.fsync=-loose-object,…` 只对包文件与引用 fsync（Windows 上的性能前提）。
 * - `info/attributes` 写入 `* -text -eol -filter -ident -working-tree-encoding`：按原样保存字节，
 *   不调用 LFS 等过滤器。
 * - 排除：项目各级 `.gitignore` 自动生效；额外规则（默认 `node_modules/` 等）、超过大小上限的文件、
 *   嵌套仓库按精确路径写入 `info/exclude`，名单保存在 `cairn-state.json`，每次检查点重新检查。
 * - 创建：`status` → 更新排除名单 → `add -A` → `write-tree` → 树与上一个检查点相同则复用 →
 *   `commit-tree` → `update-ref`。
 * - 恢复：先建检查点，`diff-tree` 得到将改动的文件（预览），`read-tree -u --reset` 改写工作区。
 *   被排除的文件不受影响；撤销恢复就是恢复到恢复前的检查点。
 * - 打开时发现影子仓库损坏（检查点的对象缺失）时删除并重建，旧检查点随之失效。
 * - 同一个对象上的操作依次执行。同一项目的多个会话（多个宿主进程）共用影子仓库、各用自己的引用；
 *   Git 的锁文件已存在时短暂等待重试。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  CheckpointError,
  CheckpointErrorCode,
  createGitRunner,
  detectGit,
  isolatedGitEnv,
  type GitResult,
  type GitRunner,
} from './git.js'
import {
  configValue,
  exactPattern,
  isCheckpointId,
  parseNameStatus,
  parseStatus,
  type FileChange,
} from './patterns.js'

export const CHECKPOINT_REF = 'refs/cairn/checkpoints'
/** 检查点引用只能在 `refs/cairn/` 之下。 */
const REF_PATTERN = /^refs\/cairn\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
/** Git 因锁文件已存在而失败（另一个进程正在写索引或引用）。 */
const LOCKED = /\.lock'?: File exists/
const LOCK_RETRY_MS = 50
const DEFAULT_LOCK_TIMEOUT_MS = 10_000
/** 默认的单个文件大小上限：10 MiB。 */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
/** 默认的额外排除规则（gitignore 语法）。 */
export const DEFAULT_EXTRA_EXCLUDES: readonly string[] = ['node_modules/', '.venv/', '__pycache__/']

const ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding\n'
const CONFIG_FILE = 'cairn.gitconfig'
const STATE_FILE = 'cairn-state.json'

export interface ShadowRepoOptions {
  /** 影子仓库目录（应用数据目录中，每个项目一个）。 */
  readonly gitDir: string
  /** 工作区（项目目录），绝对路径。 */
  readonly workTree: string
  /** Git 可执行文件，默认 PATH 中的 `git`。 */
  readonly gitBinary?: string
  /** 随包 MinGit 的受控环境变量（`GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR`、`PATH`）。 */
  readonly gitEnv?: Readonly<Record<string, string>>
  /** 继承的环境变量，默认 `process.env`（其中的 `GIT_*` 会被去掉）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly maxFileBytes?: number
  readonly extraExcludes?: readonly string[]
  /**
   * 检查点所在的引用，默认 `refs/cairn/checkpoints`。同一项目的多个会话共用一个影子仓库（对象与索引），
   * 各用自己的引用（如 `refs/cairn/sessions/<sessionId>`），提交链互不影响。
   */
  readonly ref?: string
  /**
   * 其他进程正在操作同一影子仓库（Git 的 `*.lock` 已存在）时重试的总时长，默认 10 秒。
   * 超时后以 `checkpoint.failed` 失败。
   */
  readonly lockTimeoutMs?: number
  /** 测试用：替换 Git 调用。 */
  readonly git?: GitRunner
}

export interface CheckpointResult {
  /** 检查点 id（提交 id）。 */
  readonly commit: string
  /** 工作区与上一个检查点相同时为 false（复用上一个）。 */
  readonly created: boolean
  /** 因超过大小上限而跳过的文件。 */
  readonly skippedLarge: readonly string[]
  /** 不受检查点保护的嵌套仓库。 */
  readonly nestedRepos: readonly string[]
  /** `git add` 的警告（如无法读取的文件），没有时为空字符串。 */
  readonly warnings: string
}

export interface RestorePlan {
  /** 恢复前创建的检查点：恢复到它即可撤销这次恢复。 */
  readonly before: string
  /** 恢复将改动的文件（相对工作区，`/` 分隔）。 */
  readonly changes: readonly FileChange[]
}

export interface ShadowRepo {
  readonly gitDir: string
  readonly workTree: string
  readonly gitVersion: string
  /** 打开时影子仓库损坏并已重建（旧检查点不再可用）。 */
  readonly rebuilt: boolean
  /** 最近的检查点；还没有时为 undefined。 */
  head(): string | undefined
  checkpoint(message: string): Promise<CheckpointResult>
  /** 检查点是否存在。 */
  has(commit: string): Promise<boolean>
  /** 两个检查点之间改动的文件（从 `from` 到 `to`）。 */
  diff(from: string, to: string): Promise<FileChange[]>
  /** 先建检查点，返回恢复到 `commit` 将改动的文件，不改动工作区。 */
  preview(commit: string): Promise<RestorePlan>
  /** 先建检查点，再把工作区恢复到 `commit`。 */
  restore(commit: string): Promise<RestorePlan>
  /** 整理对象（空闲时调用）。 */
  gc(): Promise<void>
}

interface State {
  large: string[]
  nested: string[]
}

/** 打开（必要时创建或重建）影子仓库；没有可用的 Git 时以 `checkpoint.git_unavailable` 失败。 */
export async function openShadowRepo(options: ShadowRepoOptions): Promise<ShadowRepo> {
  const { gitDir, workTree } = options
  const ref = options.ref ?? CHECKPOINT_REF
  if (!REF_PATTERN.test(ref) || ref.includes('..') || ref.endsWith('.lock')) {
    throw new CheckpointError(CheckpointErrorCode.Failed, `invalid checkpoint ref ${ref}`)
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const extraExcludes = options.extraExcludes ?? DEFAULT_EXTRA_EXCLUDES
  const git =
    options.git ??
    createGitRunner({
      ...(options.gitBinary !== undefined ? { binary: options.gitBinary } : {}),
      // 不存在的文件：Git 视为空的用户级配置
      env: isolatedGitEnv(
        options.env ?? process.env,
        path.join(gitDir, 'no-global-config'),
        options.gitEnv,
      ),
    })

  const detection = await detectGit(git)
  if (!detection.available) {
    throw new CheckpointError(CheckpointErrorCode.GitUnavailable, `git ${detection.reason}`, {
      reason: detection.reason,
      ...(detection.version !== undefined ? { version: detection.version } : {}),
    })
  }

  const run = async (
    args: readonly string[],
    opts: { stdin?: string; allowFail?: boolean } = {},
  ): Promise<GitResult> => {
    const fullArgs = ['--git-dir', gitDir, '--work-tree', workTree, ...args]
    const deadline = Date.now() + lockTimeoutMs
    for (;;) {
      const result = await git.run(fullArgs, {
        cwd: workTree,
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        allowFail: true,
      })
      const locked = result.code !== 0 && LOCKED.test(result.stderr) && Date.now() < deadline
      if (!locked) {
        if (result.code !== 0 && !opts.allowFail) {
          throw new CheckpointError(
            CheckpointErrorCode.Failed,
            `git ${args.join(' ')} exited with ${result.code}: ${result.stderr}`,
            { exitCode: String(result.code) },
          )
        }
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  const text = async (args: readonly string[]) => (await run(args)).stdout.toString('utf8').trim()
  const infoDir = path.join(gitDir, 'info')
  const excludeFile = path.join(infoDir, 'exclude')
  const stateFile = path.join(gitDir, STATE_FILE)

  const create = async () => {
    fs.rmSync(gitDir, { recursive: true, force: true })
    fs.mkdirSync(gitDir, { recursive: true })
    await git.run(['--git-dir', gitDir, 'init', '-q', '--template='])
    await git.run(['--git-dir', gitDir, 'config', 'include.path', CONFIG_FILE])
  }

  const writeConfig = () => {
    const slash = (p: string) => p.split(path.sep).join('/')
    const settings: [string, Record<string, string>][] = [
      [
        'core',
        {
          bare: 'false',
          autocrlf: 'false',
          safecrlf: 'false',
          quotePath: 'false',
          longpaths: 'true',
          untrackedCache: 'true',
          fsmonitor: 'false',
          // Git for Windows 在系统级配置中开启；系统级配置已屏蔽，这里显式开启（其他平台忽略）
          fscache: 'true',
          excludesFile: configValue(slash(excludeFile)),
          hooksPath: configValue(slash(path.join(gitDir, 'no-hooks'))),
          bigFileThreshold: '1',
          // 在平台默认值上增减：去掉松散对象（此时只有树与提交），包文件与引用照常 fsync
          fsync: '-loose-object,pack,pack-metadata,reference',
        },
      ],
      ['gc', { auto: '0' }],
      ['maintenance', { auto: 'false' }],
      ['commit', { gpgSign: 'false' }],
      ['user', { name: 'Cairn', email: 'checkpoint@cairn.invalid' }],
    ]
    const body = settings
      .map(([section, values]) =>
        [`[${section}]`, ...Object.entries(values).map(([k, v]) => `\t${k} = ${v}`)].join('\n'),
      )
      .join('\n')
    fs.writeFileSync(path.join(gitDir, CONFIG_FILE), body + '\n')
    fs.mkdirSync(infoDir, { recursive: true })
    fs.writeFileSync(path.join(infoDir, 'attributes'), ATTRIBUTES)
  }

  const readState = (): State => {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<State>
      const list = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      return { large: list(parsed.large), nested: list(parsed.nested) }
    } catch {
      return { large: [], nested: [] }
    }
  }

  // 影子仓库位于工作区之内时（如把用户主目录作为项目）不快照它自己
  const self = path.relative(workTree, gitDir)
  const selfExclude =
    self !== '' && !self.startsWith('..') && !path.isAbsolute(self)
      ? [exactPattern(self.split(path.sep).join('/')) + '/']
      : []

  const writeExcludes = (state: State) => {
    const lines = [
      '# 额外排除规则',
      ...extraExcludes,
      ...selfExclude,
      '# 嵌套仓库',
      ...state.nested.map((rel) => exactPattern(rel) + '/'),
      '# 超过大小上限的文件',
      ...state.large.map(exactPattern),
    ]
    fs.writeFileSync(excludeFile, lines.join('\n') + '\n')
    fs.writeFileSync(stateFile, JSON.stringify(state))
  }

  /** 已有检查点的提交与树；还没有时为 undefined，对象缺失（损坏）时抛出。 */
  const readHead = async (): Promise<{ commit: string; tree: string } | undefined> => {
    // 只解析引用，不要求对象存在
    const resolved = await run(['rev-parse', '-q', '--verify', ref], { allowFail: true })
    if (resolved.code !== 0) return undefined
    const commit = resolved.stdout.toString('utf8').trim()
    const tree = await run(['rev-parse', '-q', '--verify', `${commit}^{tree}`], { allowFail: true })
    if (tree.code !== 0) throw new Error('corrupt')
    return { commit, tree: tree.stdout.toString('utf8').trim() }
  }

  let rebuilt = false
  let current: { commit: string; tree: string } | undefined
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    await create()
  } else {
    try {
      writeConfig()
      current = await readHead()
    } catch {
      rebuilt = true
      await create()
    }
  }
  writeConfig()
  let state = rebuilt ? { large: [], nested: [] } : readState()
  writeExcludes(state)

  const isLarge = (rel: string) => {
    try {
      const st = fs.lstatSync(path.join(workTree, ...rel.split('/')))
      return st.isFile() && st.size > maxFileBytes
    } catch {
      return false
    }
  }
  const isRepo = (rel: string) => fs.existsSync(path.join(workTree, ...rel.split('/'), '.git'))

  /**
   * 引用可能已被其他进程更新（同一会话的检查点也可能由主进程在恢复时创建，M1-12c），每次创建检查点前
   * 重新读取，避免在过期的提交上继续。
   */
  const refreshHead = async () => {
    const resolved = await run(['rev-parse', '-q', '--verify', ref], { allowFail: true })
    const commit = resolved.code === 0 ? resolved.stdout.toString('utf8').trim() : undefined
    if (commit === current?.commit) return
    current =
      commit === undefined
        ? undefined
        : { commit, tree: await text(['rev-parse', '--verify', `${commit}^{tree}`]) }
  }

  const checkpoint = async (message: string): Promise<CheckpointResult> => {
    await refreshHead()
    const before = JSON.stringify(state)
    const large = new Set(state.large.filter(isLarge))
    const nested = new Set(state.nested.filter(isRepo))
    const status = parseStatus(
      (await run(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames']))
        .stdout,
    )
    for (const rel of status.changed) if (isLarge(rel)) large.add(rel)
    for (const rel of status.nested) nested.add(rel)
    const next = { large: [...large].sort(), nested: [...nested].sort() }
    if (JSON.stringify(next) !== before) {
      state = next
      writeExcludes(state)
      const excluded = [...next.nested, ...next.large]
      if (excluded.length > 0) {
        // 之前已收录的移出索引（缩小到上限以内的文件之后会被 add 重新收录）
        await run(
          [
            'rm',
            '--cached',
            '-r',
            '-f',
            '-q',
            '--ignore-unmatch',
            '--pathspec-from-file=-',
            '--pathspec-file-nul',
          ],
          { stdin: excluded.join('\0') },
        )
      }
    }
    const add = await run(['add', '-A', '--ignore-errors'], { allowFail: true })
    if (add.code !== 0 && !/^(?:warning|error): /m.test(add.stderr)) {
      throw new CheckpointError(CheckpointErrorCode.Failed, `git add failed: ${add.stderr}`)
    }
    const tree = await text(['write-tree'])
    let created = false
    if (!current || tree !== current.tree) {
      const commit = await text([
        'commit-tree',
        tree,
        '-m',
        message,
        ...(current ? ['-p', current.commit] : []),
      ])
      await run(['update-ref', ref, commit, ...(current ? [current.commit] : [])])
      current = { commit, tree }
      created = true
    }
    return {
      commit: current.commit,
      created,
      skippedLarge: state.large,
      nestedRepos: state.nested,
      warnings: add.code === 0 ? '' : add.stderr,
    }
  }

  const has = async (commit: string) =>
    isCheckpointId(commit) &&
    (await run(['cat-file', '-e', `${commit}^{commit}`], { allowFail: true })).code === 0

  const requireCheckpoint = async (commit: string) => {
    if (!(await has(commit))) {
      throw new CheckpointError(CheckpointErrorCode.NotFound, `checkpoint ${commit} not found`, {
        checkpointId: commit,
      })
    }
  }

  const diff = async (from: string, to: string) => {
    await requireCheckpoint(from)
    await requireCheckpoint(to)
    return parseNameStatus(
      (await run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to])).stdout,
    )
  }

  const plan = async (commit: string): Promise<RestorePlan> => {
    await requireCheckpoint(commit)
    const pre = await checkpoint(`before restore to ${commit}`)
    return { before: pre.commit, changes: await diff(pre.commit, commit) }
  }

  // 依次执行
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task)
    queue = result.catch(() => undefined)
    return result
  }

  return {
    gitDir,
    workTree,
    gitVersion: detection.version,
    rebuilt,
    head: () => current?.commit,
    checkpoint: (message) => serial(() => checkpoint(message)),
    has: (commit) => serial(() => has(commit)),
    diff: (from, to) => serial(() => diff(from, to)),
    preview: (commit) => serial(() => plan(commit)),
    restore: (commit) =>
      serial(async () => {
        const result = await plan(commit)
        // 索引此时与刚建的检查点一致：只改写有差异的文件，删除目标中没有的文件并清理空目录
        await run(['read-tree', '-u', '--reset', commit])
        return result
      }),
    gc: () =>
      serial(async () => {
        await run(['gc', '--quiet', '--prune=now'])
      }),
  }
}
