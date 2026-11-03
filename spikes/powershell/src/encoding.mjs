// @ts-check
/**
 * 编码、转义与退出码检查。每项用三种方式运行：
 *
 * - `raw`：不做任何设置（默认行为，对照组）；
 * - `prelude`：前置脚本 + 用户脚本直接拼接；
 * - `recommended`：前置脚本 + 用户脚本以脚本块点执行 + 结尾按原生命令的退出码退出（ADR-0012 的候选做法）。
 *
 * `required` 的检查项要求 `recommended` 通过；其余只记录结果。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { findPython, psQuote, runPowerShell, runProcess, text } from './powershell.mjs'

const NODE = process.execPath
const node = (/** @type {string} */ code) => `& ${psQuote(NODE)} -e ${psQuote(code)}`

/** @typedef {'raw' | 'prelude' | 'recommended'} Mode */
export const MODES = /** @type {const} */ (['raw', 'prelude', 'recommended'])

/**
 * @typedef {object} Ctx
 * @property {string} work 每项检查独立的工作目录
 * @property {string | undefined} python
 *
 * @typedef {object} Outcome
 * @property {boolean} ok
 * @property {string} detail
 *
 * @typedef {object} Case
 * @property {string} id
 * @property {string} title
 * @property {boolean} required
 * @property {(ctx: Ctx) => string | undefined} script 返回 undefined 表示不适用（如没有 Python）
 * @property {(r: import('./powershell.mjs').RunResult, ctx: Ctx) => Outcome} check
 * @property {(ctx: Ctx) => void} [prepare]
 * @property {number} [timeoutMs]
 */

/** 期望 stdout 恰好是 `want`。 */
const stdoutIs = (/** @type {string} */ want) =>
  /** @type {Case['check']} */ (
    (r) => {
      const got = text(r.stdout)
      return {
        ok: got === want,
        detail: got === want ? '' : `stdout=${JSON.stringify(got.slice(0, 120))}`,
      }
    }
  )

const SPECIAL = '单引号 \' 双引号 " $env:PATH `反引号 & | ; % ^ < > \t制表 😀 ✓'
const long = (/** @type {string} */ unit, /** @type {number} */ n) => unit.repeat(n)

/** @type {Case[]} */
export const CASES = [
  {
    id: 'ps-literal',
    title: 'PowerShell 输出中文字面量',
    required: true,
    script: () => "Write-Output '中文输出：你好，世界 ✓ 😀'",
    check: stdoutIs('中文输出：你好，世界 ✓ 😀'),
  },
  {
    id: 'write-host',
    title: 'Write-Host 中文',
    required: true,
    script: () => "Write-Host '主机输出：中文'",
    check: stdoutIs('主机输出：中文'),
  },
  {
    id: 'native-node',
    title: '原生程序输出 UTF-8（node）',
    required: true,
    script: () => node("process.stdout.write('原生程序：中文\\n')"),
    check: stdoutIs('原生程序：中文'),
  },
  {
    id: 'native-cmd',
    title: '原生程序按控制台代码页输出（cmd echo）',
    required: true,
    script: () => "& cmd.exe /d /c 'echo cmd 输出：中文'",
    check: stdoutIs('cmd 输出：中文'),
  },
  {
    id: 'python-default',
    title: 'Python print（默认编码）',
    required: false,
    script: (c) => (c.python ? `& ${c.python} -c "print('Python 输出：中文')"` : undefined),
    check: stdoutIs('Python 输出：中文'),
  },
  {
    id: 'python-utf8',
    title: 'Python print（PYTHONUTF8=1）',
    required: false,
    script: (c) =>
      c.python ? `$env:PYTHONUTF8 = '1'\n& ${c.python} -c "print('Python 输出：中文')"` : undefined,
    check: stdoutIs('Python 输出：中文'),
  },
  {
    id: 'stderr',
    title: 'Write-Error 中文走 stderr，无 CLIXML、无颜色控制符',
    required: true,
    script: () => "Write-Error '错误：中文'",
    check: (r) => {
      const err = text(r.stderr)
      const ok = err.includes('错误：中文') && !err.includes('CLIXML') && !err.includes('\x1b')
      return { ok, detail: ok ? '' : `stderr=${JSON.stringify(err.slice(0, 160))}` }
    },
  },
  {
    id: 'progress',
    title: '进度条不写入 stderr（CLIXML）',
    required: true,
    script: () =>
      "1..3 | ForEach-Object { Write-Progress -Activity '进度' -PercentComplete ($_ * 30); Start-Sleep -Milliseconds 50 }\nWrite-Output 'done'",
    check: (r) => {
      const err = text(r.stderr)
      const ok = text(r.stdout) === 'done' && !err.includes('CLIXML')
      return { ok, detail: ok ? '' : `stderr=${JSON.stringify(err.slice(0, 120))}` }
    },
  },
  {
    id: 'file-read',
    title: 'Get-Content 读取无 BOM 的 UTF-8 文件',
    required: true,
    prepare: (c) => writeFileSync(path.join(c.work, 'utf8.txt'), '文件内容：中文\n'),
    script: () => 'Get-Content utf8.txt',
    check: stdoutIs('文件内容：中文'),
  },
  {
    id: 'file-write',
    title: '重定向 `>` 写文件的编码',
    required: true,
    script: () => "'写入：中文' > out.txt",
    check: (r, c) => {
      let bytes
      try {
        bytes = readFileSync(path.join(c.work, 'out.txt'))
      } catch {
        return { ok: false, detail: '没有生成文件' }
      }
      const kind =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'UTF-16LE'
          : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
            ? 'UTF-8 BOM'
            : 'UTF-8 / 其他'
      const body =
        kind === 'UTF-16LE' ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
      const ok = kind !== 'UTF-16LE' && body.replace(/^\uFEFF/, '').trim() === '写入：中文'
      return { ok, detail: kind }
    },
  },
  {
    id: 'args',
    title: '向原生程序传中文参数（含空格）',
    required: true,
    script: () => `${node('console.log(process.argv[1])')} '参数：中文 空格'`,
    check: stdoutIs('参数：中文 空格'),
  },
  {
    id: 'cn-path',
    title: '中文目录名',
    required: true,
    script: () =>
      "New-Item -ItemType Directory '中文目录' | Out-Null\n(Get-ChildItem -Directory).Name",
    check: stdoutIs('中文目录'),
  },
  {
    id: 'special',
    title: '特殊字符原样传入（引号、$、反引号、管道符、制表符、emoji）',
    required: true,
    script: () => `Write-Output @'\n${SPECIAL}\n'@`,
    check: stdoutIs(SPECIAL),
  },
  {
    id: 'syntax-error',
    title: '用户脚本语法错误时，错误信息中的中文可读',
    required: true,
    script: () => "Write-Output '开始'\nif ( { '语法错误：中文'",
    check: (r) => {
      const err = text(r.stderr)
      const ok = err.includes('语法错误：中文') && r.code !== 0
      return {
        ok,
        detail: `code=${r.code}${ok ? '' : ` stderr=${JSON.stringify(err.slice(0, 120))}`}`,
      }
    },
  },
  {
    id: 'exit-ps',
    title: '`exit 7` 的退出码',
    required: true,
    script: () => 'exit 7',
    check: (r) => ({ ok: r.code === 7, detail: `code=${r.code}` }),
  },
  {
    id: 'exit-native',
    title: '最后一条原生命令失败（退出码 3）',
    required: true,
    script: () => node('process.exit(3)'),
    check: (r) => ({ ok: r.code === 3, detail: `code=${r.code}` }),
  },
  {
    id: 'exit-native-then-ok',
    title: '原生命令失败后又成功（最后退出码 0）',
    required: true,
    script: () => `${node('process.exit(3)')}\n${node('process.exit(0)')}`,
    check: (r) => ({ ok: r.code === 0, detail: `code=${r.code}` }),
  },
  {
    id: 'read-host',
    title: 'Read-Host 不挂起（不支持交互）',
    required: true,
    timeoutMs: 15_000,
    script: () => "Read-Host '请输入'\nWrite-Output '之后'",
    check: (r) => ({
      ok: !r.timedOut,
      detail: `${r.timedOut ? '超时' : `code=${r.code}`} ${r.ms} ms`,
    }),
  },
  ...[2_000, 6_000, 10_000, 14_000].map(
    (n) =>
      /** @type {Case} */ ({
        id: `long-ascii-${n}`,
        title: `长脚本：${n} 个 ASCII 字符`,
        required: false,
        script: () => `Write-Output '${long('a', n)}'`,
        check: (r) => {
          const got = text(r.stdout)
          return {
            ok: got.length === n,
            detail: `命令行 ${r.cmdChars} 字符${got.length === n ? '' : `；len=${got.length} ${r.spawnError ?? text(r.stderr).slice(0, 80)}`}`,
          }
        },
      }),
  ),
  ...[1_000, 2_000, 4_000].map(
    (n) =>
      /** @type {Case} */ ({
        id: `long-cn-${n}`,
        title: `长脚本：${n} 个汉字`,
        required: false,
        script: () => `Write-Output '${long('中', n)}'`,
        check: (r) => {
          const got = text(r.stdout)
          return {
            ok: got === long('中', n),
            detail: `命令行 ${r.cmdChars} 字符${got.length === n ? '' : `；len=${got.length} ${r.spawnError ?? text(r.stderr).slice(0, 80)}`}`,
          }
        },
      }),
  ),
]

/**
 * 长脚本的回退：写成带 BOM 的 UTF-8 `.ps1`，以 `-File` 运行（不受命令行长度限制）。
 * @param {{ exe: string }} shell
 * @param {string} work
 */
export async function runFileFallback(shell, work) {
  const n = 30_000
  const script = `${'# 注释填充\n'.repeat(2_000)}Write-Output '${long('中', n)}'\n`
  const file = path.join(work, 'long.ps1')
  writeFileSync(file, `\uFEFF${script}`, 'utf8')
  const r = await runProcess(
    shell.exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    {
      cwd: work,
    },
  )
  const got = text(r.stdout)
  return { ok: got === long('中', n), detail: `${script.length} 字符，${r.ms} ms，code=${r.code}` }
}

/**
 * 启动耗时：`exit 0` 运行 5 次的中位数（ms）。
 * @param {{ exe: string }} shell
 */
export async function startupMs(shell) {
  const times = []
  for (let i = 0; i < 5; i++) {
    times.push((await runPowerShell(shell, 'exit 0', { wrap: 'scriptblock' })).ms)
  }
  times.sort((a, b) => a - b)
  return times[2]
}

/**
 * @param {{ id: string, exe: string }} shell
 * @param {string} workRoot
 */
export async function runEncodingCases(shell, workRoot) {
  const python = findPython()
  /** @type {{ id: string, title: string, required: boolean, results: Record<string, Outcome | null> }[]} */
  const rows = []
  for (const c of CASES) {
    /** @type {Record<string, Outcome | null>} */
    const results = {}
    for (const mode of MODES) {
      const work = path.join(workRoot, shell.id, c.id, mode)
      rmSync(work, { recursive: true, force: true })
      mkdirSync(work, { recursive: true })
      const ctx = { work, python }
      const script = c.script(ctx)
      if (script === undefined) {
        results[mode] = null
        continue
      }
      c.prepare?.(ctx)
      const r = await runPowerShell(shell, script, {
        wrap: mode === 'raw' ? 'raw' : mode === 'prelude' ? 'prelude' : 'scriptblock',
        epilogue: mode === 'recommended',
        cwd: work,
        timeoutMs: c.timeoutMs ?? 30_000,
      })
      results[mode] = c.check(r, ctx)
    }
    rows.push({ id: c.id, title: c.title, required: c.required, results })
  }
  return rows
}
