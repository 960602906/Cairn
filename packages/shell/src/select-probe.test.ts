import { describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

const { defaultShellProbe } = await import('./select.js')

describe('defaultShellProbe：PowerShell 输出', () => {
  it('输出只有版本号时没有实际路径', async () => {
    execFileMock.mockImplementation(
      (
        _exe: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, '7.5.4\n'),
    )
    await expect(defaultShellProbe('pwsh.exe', 'pwsh')).resolves.toEqual({ version: '7.5.4' })
    expect(execFileMock).toHaveBeenCalledWith(
      'pwsh.exe',
      expect.arrayContaining(['-NoProfile']),
      expect.any(Object),
      expect.any(Function),
    )
  })
})
