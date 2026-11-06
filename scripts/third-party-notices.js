// @ts-check
/**
 * 生成第三方许可声明（ADR-0014，M1-01d）：列出桌面应用的全部生产依赖（随应用分发，含打进产物的 pi
 * 及其依赖），每项给出名称、版本、许可证、作者、主页，并附上包中的许可证全文。
 *
 * 依赖清单来自 `pnpm licenses list --prod --json`（在 apps/desktop 中执行），另加随应用分发的外部二进制
 *（scripts/bundled-binaries.json，如 ripgrep，许可证全文在 scripts/licenses/ 中）。许可证是否允许由
 * `check-licenses.js` 检查，这里只负责汇总。
 *
 * 用法：node scripts/third-party-notices.js <输出文件>
 *（桌面应用的 `build` 脚本输出到 `apps/desktop/out/THIRD_PARTY_NOTICES.txt`）
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { binariesReport, loadBundledBinaries, parseLicenseOutput } from './check-licenses.js'

/**
 * @typedef {{ name: string, versions: string[], paths?: string[], license: string, author?: string, homepage?: string }} ReportedPackage
 * @typedef {Record<string, ReportedPackage[]>} NoticeReport
 */

/** 许可证文件名（不区分大小写）：LICENSE、LICENCE、COPYING，可带扩展名或后缀（如 LICENSE-MIT）。 */
const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i

/**
 * 在包目录中找许可证文件，返回全文；找不到返回 undefined。
 * @param {string} dir
 * @param {{ list: (dir: string) => string[], read: (file: string) => string }} fs
 */
export function findLicenseText(dir, fs) {
  let names
  try {
    names = fs.list(dir)
  } catch {
    return undefined
  }
  const file = names.filter((n) => LICENSE_FILE.test(n)).sort()[0]
  return file === undefined ? undefined : fs.read(path.join(dir, file)).trim()
}

/**
 * @param {NoticeReport} report
 * @param {(dir: string) => string | undefined} licenseText
 * @returns {string}
 */
export function buildNotices(report, licenseText) {
  /** @type {{ key: string, text: string }[]} */
  const entries = []
  for (const packages of Object.values(report)) {
    for (const pkg of packages) {
      pkg.versions.forEach((version, i) => {
        const dir = pkg.paths?.[i] ?? pkg.paths?.[0]
        const lines = [`${pkg.name}@${version}`, `License: ${pkg.license}`]
        if (pkg.author) lines.push(`Author: ${pkg.author}`)
        if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`)
        const text = dir === undefined ? undefined : licenseText(dir)
        lines.push('', text ?? '(No license file is included in the package.)')
        entries.push({ key: `${pkg.name}@${version}`, text: lines.join('\n') })
      })
    }
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const header = [
    'Cairn includes the following third-party software.',
    `${entries.length} packages.`,
  ].join('\n')
  const rule = `\n\n${'-'.repeat(80)}\n\n`
  return [header, ...entries.map((e) => e.text)].join(rule) + '\n'
}

/* v8 ignore start -- 命令行入口：调用真实的 pnpm 与文件系统，逻辑已由上面的函数覆盖 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: node scripts/third-party-notices.js <output file>')
    process.exit(2)
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const output = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: path.join(root, 'apps/desktop'),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const report = /** @type {NoticeReport} */ ({
    ...parseLicenseOutput(output),
    ...binariesReport(loadBundledBinaries(root), root),
  })
  const notices = buildNotices(report, (dir) =>
    findLicenseText(dir, {
      list: (d) => readdirSync(d),
      read: (f) => readFileSync(f, 'utf8'),
    }),
  )
  writeFileSync(out, notices)
  console.log(`Wrote ${out}`)
}
/* v8 ignore stop */
