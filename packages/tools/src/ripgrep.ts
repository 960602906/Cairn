/**
 * 随应用打包的 ripgrep（M1-07b）：构建时把当前平台的 `rg` 复制到 `out/bin/`（见 apps/desktop 的构建配置）。
 * 打包进 `app.asar` 后，可执行文件位于 `app.asar.unpacked` 中（asar 内的文件不能执行）。
 */
import { execFile } from 'node:child_process'
import nodePath from 'node:path'

/** 当前平台 ripgrep 可执行文件的名称。 */
export const RIPGREP_BINARY = process.platform === 'win32' ? 'rg.exe' : 'rg'

/**
 * 给出目录中的 ripgrep 路径。目录位于 `app.asar` 内时改为 `app.asar.unpacked` 中的同一位置。
 * @param binDir 存放 ripgrep 的目录，如 `out/bin`。
 */
export function bundledRipgrepPath(binDir: string): string {
  const file = nodePath.join(binDir, RIPGREP_BINARY)
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** 运行 `rg --version`，返回第一行（如 `ripgrep 14.1.1`）。找不到或无法运行时抛出。 */
export function ripgrepVersion(ripgrepPath: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ripgrepPath, ['--version'], { timeout: timeoutMs, windowsHide: true }, (e, stdout) => {
      if (e) reject(e)
      else resolve(stdout.split(/\r?\n/)[0]!.trim())
    })
  })
}
