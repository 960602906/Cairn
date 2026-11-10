import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ACCEPTANCE_DIRECTORIES,
  installedAcceptance,
  runCli,
  systemOnlyPath,
} from './acceptance-installed.mjs'

describe('systemOnlyPath', () => {
  it('只保留系统目录，不包含 Git 或开发工具路径', () => {
    const value = systemOnlyPath({ SystemRoot: 'D:\\Windows' })
    expect(value.split(';')).toEqual([
      'D:\\Windows\\System32',
      'D:\\Windows',
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ])
    expect(value.toLowerCase()).not.toContain('git')
    expect(value.toLowerCase()).not.toContain('node')
  })

  it('没有 SystemRoot 时回退到系统盘默认目录', () => {
    expect(systemOnlyPath({})).toBe(
      [
        'C:\\Windows\\System32',
        'C:\\Windows',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      ].join(path.delimiter),
    )
  })
})

describe('installedAcceptance', () => {
  it('在中文长路径下启用重装验收，并只给应用系统 PATH', async () => {
    const run = vi.fn(async () => [])
    const removeWorkRoot = vi.fn()
    const log = vi.fn()
    const problems = await installedAcceptance({
      run: run as never,
      env: { SystemRoot: 'C:\\Windows' },
      createWorkRoot: () => 'C:\\temp\\acceptance-root',
      removeWorkRoot,
      log,
    })

    expect(problems).toEqual([])
    const options = run.mock.calls[0]?.[0] as {
      workRoot: string
      installDir: string
      userData: string
      reinstall: boolean
      appEnv: { PATH: string }
      env: NodeJS.ProcessEnv
    }
    expect(options.workRoot).toBe('C:\\temp\\acceptance-root')
    expect(options.installDir).toBe(
      path.join('C:\\temp\\acceptance-root', ...ACCEPTANCE_DIRECTORIES.install),
    )
    expect(options.userData).toBe(
      path.join('C:\\temp\\acceptance-root', ...ACCEPTANCE_DIRECTORIES.data),
    )
    expect(options.installDir).toContain('验收')
    expect(options.reinstall).toBe(true)
    expect(options.appEnv.PATH).toBe(systemOnlyPath({ SystemRoot: 'C:\\Windows' }))
    expect(options.env['SystemRoot']).toBe('C:\\Windows')
    expect(log).toHaveBeenCalledWith(expect.stringContaining(options.installDir))
    expect(removeWorkRoot).toHaveBeenCalledWith('C:\\temp\\acceptance-root')
  })

  it('验收失败时仍然清理临时目录', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom')
    })
    const removeWorkRoot = vi.fn()
    await expect(
      installedAcceptance({
        run: run as never,
        createWorkRoot: () => 'C:\\temp\\root',
        removeWorkRoot,
        log: vi.fn(),
      }),
    ).rejects.toThrow('boom')
    expect(removeWorkRoot).toHaveBeenCalledWith('C:\\temp\\root')
  })
})

describe('runCli', () => {
  it('验收通过时退出码为 0', async () => {
    const print = vi.fn()
    const setExitCode = vi.fn()
    const error = vi.fn()
    await expect(runCli({ run: async () => [], print, error, setExitCode })).resolves.toBe(0)
    expect(print).toHaveBeenCalledWith('acceptance:installed: passed')
    expect(setExitCode).toHaveBeenLastCalledWith(0)
    expect(error).not.toHaveBeenCalled()
  })

  it('有问题时逐条输出并以 1 退出', async () => {
    const print = vi.fn()
    const setExitCode = vi.fn()
    const error = vi.fn()
    await expect(runCli({ run: async () => ['a', 'b'], print, error, setExitCode })).resolves.toBe(
      1,
    )
    expect(error).toHaveBeenCalledWith('acceptance:installed: a')
    expect(error).toHaveBeenCalledWith('acceptance:installed: b')
    expect(print).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenLastCalledWith(1)
  })
})
