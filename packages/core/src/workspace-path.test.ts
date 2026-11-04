import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PathErrorCode,
  resolveWorkspacePath,
  resolveWorkspacePathLexical,
  type PathFileSystem,
  type PathStyle,
} from './workspace-path.js'

const ok = (absolute: string, relative: string) => ({ ok: true, path: { absolute, relative } })
const err = (code: string) => ({ ok: false, code })

describe('resolveWorkspacePathLexical：posix', () => {
  const root = '/home/u/proj'
  it.each([
    ['src/a.ts', ok('/home/u/proj/src/a.ts', 'src/a.ts')],
    ['./src//a.ts', ok('/home/u/proj/src/a.ts', 'src/a.ts')],
    ['.', ok('/home/u/proj', '.')],
    ['src/..', ok('/home/u/proj', '.')],
    ['src/../lib/./b.ts', ok('/home/u/proj/lib/b.ts', 'lib/b.ts')],
    ['/home/u/proj/a', ok('/home/u/proj/a', 'a')],
    ['/home/u/proj', ok('/home/u/proj', '.')],
    ['dir\\..\\..\\x', ok('/home/u/proj/dir\\..\\..\\x', 'dir\\..\\..\\x')],
    ['~/.ssh', ok('/home/u/proj/~/.ssh', '~/.ssh')],
    ['..', err(PathErrorCode.OutsideWorkspace)],
    ['../proj2/a', err(PathErrorCode.OutsideWorkspace)],
    ['a/../../proj/../x', err(PathErrorCode.OutsideWorkspace)],
    ['/home/u/proj2', err(PathErrorCode.OutsideWorkspace)],
    ['/home/u', err(PathErrorCode.OutsideWorkspace)],
    ['/etc/passwd', err(PathErrorCode.OutsideWorkspace)],
    ['/../../home/u/proj/a', ok('/home/u/proj/a', 'a')],
    ['/home/u/PROJ/a', err(PathErrorCode.OutsideWorkspace)],
    ['', err(PathErrorCode.Empty)],
    ['   ', err(PathErrorCode.Empty)],
    ['a\0b', err(PathErrorCode.InvalidCharacter)],
  ])('%j', (input, expected) => {
    expect(resolveWorkspacePathLexical(root, input, 'posix')).toEqual(expected)
  })

  it('根目录本身可以是 / 或带 .. 与多余分隔符', () => {
    expect(resolveWorkspacePathLexical('/', 'etc/hosts', 'posix')).toEqual(
      ok('/etc/hosts', 'etc/hosts'),
    )
    expect(resolveWorkspacePathLexical('/home/u/x/../proj/', 'a', 'posix')).toEqual(
      ok('/home/u/proj/a', 'a'),
    )
  })

  it('根目录必须是绝对路径', () => {
    expect(resolveWorkspacePathLexical('proj', 'a', 'posix')).toEqual(
      err(PathErrorCode.RootNotAbsolute),
    )
    expect(resolveWorkspacePathLexical('/a\0', 'a', 'posix')).toEqual(
      err(PathErrorCode.InvalidCharacter),
    )
  })
})

describe('resolveWorkspacePathLexical：win32', () => {
  const root = 'C:\\Users\\Lan\\Proj'
  it.each([
    ['src\\a.ts', ok('C:\\Users\\Lan\\Proj\\src\\a.ts', 'src/a.ts')],
    ['src/a.ts', ok('C:\\Users\\Lan\\Proj\\src\\a.ts', 'src/a.ts')],
    ['.\\src\\\\a.ts', ok('C:\\Users\\Lan\\Proj\\src\\a.ts', 'src/a.ts')],
    ['.', ok('C:\\Users\\Lan\\Proj', '.')],
    ['src\\..\\lib\\b.ts', ok('C:\\Users\\Lan\\Proj\\lib\\b.ts', 'lib/b.ts')],
    // 盘符与目录大小写不同：仍在工作区内，工作区部分沿用根目录的写法
    ['c:\\users\\lan\\proj\\Src\\A.ts', ok('C:\\Users\\Lan\\Proj\\Src\\A.ts', 'Src/A.ts')],
    ['C:/Users/Lan/Proj/a', ok('C:\\Users\\Lan\\Proj\\a', 'a')],
    // 以 \ 开头：根目录所在盘的根
    ['\\Users\\Lan\\Proj\\a', ok('C:\\Users\\Lan\\Proj\\a', 'a')],
    ['\\Windows\\System32', err(PathErrorCode.OutsideWorkspace)],
    // 扩展长度前缀
    ['\\\\?\\C:\\Users\\Lan\\Proj\\a', ok('C:\\Users\\Lan\\Proj\\a', 'a')],
    ['//?/c:/users/lan/proj/a', ok('C:\\Users\\Lan\\Proj\\a', 'a')],
    ['\\??\\C:\\Users\\Lan\\Proj\\a', ok('C:\\Users\\Lan\\Proj\\a', 'a')],
    ['\\\\?\\C:\\Users\\Lan\\Other', err(PathErrorCode.OutsideWorkspace)],
    ['\\\\?\\GLOBALROOT\\Device\\x', err(PathErrorCode.Device)],
    ['\\\\?\\C:', err(PathErrorCode.Device)],
    ['\\\\.\\C:\\Users\\Lan\\Proj\\a', err(PathErrorCode.Device)],
    ['\\\\.\\PhysicalDrive0', err(PathErrorCode.Device)],
    // 越界
    ['..', err(PathErrorCode.OutsideWorkspace)],
    ['..\\Proj2\\a', err(PathErrorCode.OutsideWorkspace)],
    ['a\\..\\..\\Proj\\..\\x', err(PathErrorCode.OutsideWorkspace)],
    ['C:\\Users\\Lan\\Proj2', err(PathErrorCode.OutsideWorkspace)],
    ['D:\\Users\\Lan\\Proj\\a', err(PathErrorCode.OutsideWorkspace)],
    ['\\\\server\\share\\a', err(PathErrorCode.OutsideWorkspace)],
    ['C:foo', err(PathErrorCode.DriveRelative)],
    ['c:..\\x', err(PathErrorCode.DriveRelative)],
    // 段末尾的点与空格
    ['.env.', ok('C:\\Users\\Lan\\Proj\\.env', '.env')],
    ['src. \\a.ts  ', ok('C:\\Users\\Lan\\Proj\\src\\a.ts', 'src/a.ts')],
    ['...', err(PathErrorCode.Malformed)],
    ['.. \\x', err(PathErrorCode.Malformed)],
    // 非法字符与备用数据流
    ['a.txt:secret', err(PathErrorCode.InvalidCharacter)],
    ['a.txt::$DATA', err(PathErrorCode.InvalidCharacter)],
    ['a?.txt', err(PathErrorCode.InvalidCharacter)],
    ['a\u0001b', err(PathErrorCode.InvalidCharacter)],
    ['a\0b', err(PathErrorCode.InvalidCharacter)],
    // 保留设备名
    ['NUL', err(PathErrorCode.Device)],
    ['src\\con.txt', err(PathErrorCode.Device)],
    ['com1 .log', err(PathErrorCode.Device)],
    ['LPT9', err(PathErrorCode.Device)],
    ['CONIN$', err(PathErrorCode.Device)],
    ['console.log', ok('C:\\Users\\Lan\\Proj\\console.log', 'console.log')],
    ['com10', ok('C:\\Users\\Lan\\Proj\\com10', 'com10')],
    ['', err(PathErrorCode.Empty)],
  ])('%j', (input, expected) => {
    expect(resolveWorkspacePathLexical(root, input, 'win32')).toEqual(expected)
  })

  it('UNC 工作区', () => {
    const unc = '\\\\Server\\Share\\proj'
    expect(resolveWorkspacePathLexical(unc, 'a\\b', 'win32')).toEqual(
      ok('\\\\Server\\Share\\proj\\a\\b', 'a/b'),
    )
    expect(resolveWorkspacePathLexical(unc, '//server/SHARE/proj/x', 'win32')).toEqual(
      ok('\\\\Server\\Share\\proj\\x', 'x'),
    )
    expect(resolveWorkspacePathLexical(unc, '\\\\?\\UNC\\server\\share\\proj\\y', 'win32')).toEqual(
      ok('\\\\Server\\Share\\proj\\y', 'y'),
    )
    // \ 开头时回到共享的根
    expect(resolveWorkspacePathLexical(unc, '\\proj\\z', 'win32')).toEqual(
      ok('\\\\Server\\Share\\proj\\z', 'z'),
    )
    expect(resolveWorkspacePathLexical(unc, '\\\\Server\\Other\\proj', 'win32')).toEqual(
      err(PathErrorCode.OutsideWorkspace),
    )
    expect(resolveWorkspacePathLexical(unc, '..\\..\\..', 'win32')).toEqual(
      err(PathErrorCode.OutsideWorkspace),
    )
  })

  it('格式不完整或含非法字符的 UNC 路径', () => {
    expect(resolveWorkspacePathLexical(root, '\\\\server', 'win32')).toEqual(
      err(PathErrorCode.Malformed),
    )
    expect(resolveWorkspacePathLexical(root, '\\\\server\\\\x', 'win32')).toEqual(
      err(PathErrorCode.Malformed),
    )
    expect(resolveWorkspacePathLexical(root, '\\\\ser*ver\\share', 'win32')).toEqual(
      err(PathErrorCode.InvalidCharacter),
    )
    expect(resolveWorkspacePathLexical(root, '\\\\server\\share\\a|b', 'win32')).toEqual(
      err(PathErrorCode.InvalidCharacter),
    )
  })

  it('根目录必须是绝对路径，且本身合法', () => {
    for (const bad of ['Proj', '\\Proj', 'C:Proj']) {
      expect(resolveWorkspacePathLexical(bad, 'a', 'win32')).toMatchObject({ ok: false })
    }
    expect(resolveWorkspacePathLexical('\\Proj', 'a', 'win32')).toEqual(
      err(PathErrorCode.RootNotAbsolute),
    )
    expect(resolveWorkspacePathLexical('C:\\', 'Windows', 'win32')).toEqual(
      ok('C:\\Windows', 'Windows'),
    )
  })
})

/** 与 Node 的 path 对照：对 Node 也能处理的普通路径，结论与绝对路径一致。 */
describe('与 Node path 对照', () => {
  const cases: Record<PathStyle, { root: string; inputs: string[] }> = {
    posix: {
      root: '/w/proj',
      inputs: [
        'a',
        'a/b/../c',
        '../proj/x',
        '../x',
        '/w/proj/a/../../proj/b',
        '/w',
        'a/./b//c',
        '..',
      ],
    },
    win32: {
      root: 'C:\\w\\proj',
      inputs: [
        'a',
        'a\\b\\..\\c',
        '..\\proj\\x',
        '..\\x',
        'C:\\w\\proj\\a\\..\\..\\proj\\b',
        'c:/w/PROJ/q',
        '\\w\\proj\\r',
        'D:\\w\\proj',
        'a/./b//c',
        '..',
      ],
    },
  }
  for (const style of ['posix', 'win32'] as const) {
    const lib = path[style]
    const { root, inputs } = cases[style]
    it.each(inputs)(`${style}: %s`, (input) => {
      const result = resolveWorkspacePathLexical(root, input, style)
      const resolved = lib.resolve(root, input)
      const rel = lib.relative(root, resolved)
      const inside = !rel.startsWith('..') && !lib.isAbsolute(rel)
      expect(result.ok).toBe(inside)
      if (result.ok) {
        const norm = (p: string) => (style === 'win32' ? p.toLowerCase() : p)
        expect(norm(result.path.absolute)).toBe(norm(resolved))
        expect(norm(result.path.relative)).toBe(
          norm(rel === '' ? '.' : rel.split(lib.sep).join('/')),
        )
      }
    })
  }
})

describe('resolveWorkspacePath：注入的文件系统', () => {
  /** 由真实路径表构造的文件系统：表中没有的路径不存在；`links` 中的路径是悬空链接。 */
  function fakeFs(real: Record<string, string>, links: string[] = []): PathFileSystem {
    return {
      realpath: async (p) => real[p],
      exists: async (p) => p in real || links.includes(p),
    }
  }

  it('根目录为文件系统根时不重复分隔符', async () => {
    const fs = fakeFs({ '/': '/', '/etc': '/etc' })
    expect(await resolveWorkspacePath('/', 'etc/new', { style: 'posix', fs })).toEqual(
      ok('/etc/new', 'etc/new'),
    )
    const win = fakeFs({ 'C:\\': 'C:\\', 'C:\\w': 'C:\\w' })
    expect(await resolveWorkspacePath('C:\\', 'w\\x', { style: 'win32', fs: win })).toEqual(
      ok('C:\\w\\x', 'w/x'),
    )
  })

  it('Windows：真实路径带 \\\\?\\ 前缀、短文件名展开为长文件名', async () => {
    const fs = fakeFs({
      'C:\\PROGRA~1\\proj': '\\\\?\\C:\\Program Files\\proj',
      'C:\\PROGRA~1\\proj\\SRC~1': '\\\\?\\C:\\Program Files\\proj\\source',
    })
    expect(
      await resolveWorkspacePath('C:\\PROGRA~1\\proj', 'SRC~1\\new.ts', { style: 'win32', fs }),
    ).toEqual(ok('C:\\Program Files\\proj\\source\\new.ts', 'source/new.ts'))
  })

  it('真实路径越界、悬空链接、根目录不存在', async () => {
    const fs = fakeFs({ '/w': '/w', '/w/l': '/etc' }, ['/w/d'])
    const opts = { style: 'posix' as const, fs }
    expect(await resolveWorkspacePath('/w', 'l/x', opts)).toEqual(
      err(PathErrorCode.OutsideWorkspace),
    )
    expect(await resolveWorkspacePath('/w', 'd/x', opts)).toEqual(err(PathErrorCode.BrokenLink))
    expect(await resolveWorkspacePath('/nope', 'x', opts)).toEqual(err(PathErrorCode.RootNotFound))
    expect(await resolveWorkspacePath('/w', '../x', opts)).toEqual(
      err(PathErrorCode.OutsideWorkspace),
    )
  })

  it('文件系统的其他错误原样抛出', async () => {
    const fs: PathFileSystem = {
      realpath: async () => {
        throw new Error('EACCES')
      },
      exists: async () => true,
    }
    await expect(resolveWorkspacePath('/w', 'x', { style: 'posix', fs })).rejects.toThrow('EACCES')
  })
})
