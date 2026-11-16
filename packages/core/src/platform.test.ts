import { describe, expect, it } from 'vitest'
import {
  caseInsensitiveFileSystem,
  isLinux,
  isMac,
  isWindows,
  pathStyleFor,
  platformBinaryName,
} from './platform.js'

const PLATFORMS = ['win32', 'darwin', 'linux', 'freebsd'] as const

describe('isWindows / isMac / isLinux', () => {
  it('按平台标识精确匹配', () => {
    expect(PLATFORMS.map(isWindows)).toEqual([true, false, false, false])
    expect(PLATFORMS.map(isMac)).toEqual([false, true, false, false])
    expect(PLATFORMS.map(isLinux)).toEqual([false, false, true, false])
  })
})

describe('pathStyleFor', () => {
  it('只有 Windows 用 win32，其余用 posix', () => {
    expect(PLATFORMS.map(pathStyleFor)).toEqual(['win32', 'posix', 'posix', 'posix'])
  })
})

describe('caseInsensitiveFileSystem', () => {
  it('Windows 与 macOS 默认大小写不敏感，Linux 与其他平台敏感', () => {
    expect(PLATFORMS.map(caseInsensitiveFileSystem)).toEqual([true, true, false, false])
  })
})

describe('platformBinaryName', () => {
  it('Windows 上补 .exe，其他平台原样', () => {
    expect(platformBinaryName('rg', 'win32')).toBe('rg.exe')
    expect(platformBinaryName('rg', 'darwin')).toBe('rg')
    expect(platformBinaryName('rg', 'linux')).toBe('rg')
    expect(platformBinaryName('rg', 'freebsd')).toBe('rg')
  })

  it('已有扩展名时不再追加 .exe', () => {
    expect(platformBinaryName('git.exe', 'win32')).toBe('git.exe')
    expect(platformBinaryName('rg.EXE', 'win32')).toBe('rg.EXE')
    expect(platformBinaryName('server.com', 'win32')).toBe('server.com')
  })

  it('没有扩展名的名称在非 Windows 平台保持不变', () => {
    expect(platformBinaryName('node', 'linux')).toBe('node')
    expect(platformBinaryName('my.tool', 'linux')).toBe('my.tool')
  })
})
