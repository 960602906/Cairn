/**
 * 随包 MinGit 的真实检查点验收（M5-03，ADR-0008）：不依赖 PATH 中的 Git，
 * 用 `resources/git` 的可执行文件与受控环境变量完成创建、预览与恢复。
 *
 * 产物由 `pnpm fetch:mingit` 生成且不提交；没有产物时跳过（Linux CI 与未下载的开发环境）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openShadowRepo } from '@cairn/checkpoint'
import { bundledGitEnv, bundledGitLayout } from '../main/services/git-locator.js'

const RESOURCES = path.resolve(import.meta.dirname, '../../resources/git')
const layout = bundledGitLayout(RESOURCES)
const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-bundled-git-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(layout === undefined)('bundled MinGit checkpoints', () => {
  it('creates, previews and restores without Git on PATH', async () => {
    const bundled = layout!
    const root = temporaryDirectory()
    const workTree = path.join(root, 'work')
    const emptyPath = path.join(root, 'empty-path')
    mkdirSync(workTree)
    mkdirSync(emptyPath)
    const note = path.join(workTree, 'note.txt')
    writeFileSync(note, 'one\n')

    // PATH 里只有随包 bin 与一个空目录：证明不依赖本机 Git。
    const env = bundledGitEnv(bundled, { ...process.env, PATH: emptyPath }, process.platform)
    expect(env['PATH']).toBe(`${bundled.binDir}${path.delimiter}${emptyPath}`)
    expect(existsSync(path.join(emptyPath, 'git.exe'))).toBe(false)

    const repo = await openShadowRepo({
      gitDir: path.join(root, 'shadow.git'),
      workTree,
      gitBinary: bundled.binary,
      gitEnv: env,
      ref: 'refs/cairn/sessions/bundled-test',
    })
    expect(repo.gitVersion).toMatch(/^2\.56\./)

    const first = await repo.checkpoint('initial')
    expect(first.created).toBe(true)
    expect(repo.head()).toBe(first.commit)

    writeFileSync(note, 'two\n')
    const second = await repo.checkpoint('turn start')
    expect(second.created).toBe(true)
    expect(second.commit).not.toBe(first.commit)

    const preview = await repo.preview(first.commit)
    expect(preview.changes).toEqual([{ path: 'note.txt', status: 'modified' }])
    expect(readFileSync(note, 'utf8')).toBe('two\n')

    const restored = await repo.restore(first.commit)
    expect(restored.changes).toEqual([{ path: 'note.txt', status: 'modified' }])
    expect(readFileSync(note, 'utf8')).toBe('one\n')
    expect(repo.head()).toBe(restored.before)
  })
})
