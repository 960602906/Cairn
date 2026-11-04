import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildNotices, findLicenseText } from './third-party-notices.js'

describe('findLicenseText', () => {
  const files: Record<string, string> = {
    [path.join('/a', 'LICENSE.md')]: '  MIT License text  \n',
    [path.join('/b', 'licence')]: 'ISC text',
    [path.join('/c', 'COPYING-BSD')]: 'BSD text',
  }
  const fs = {
    list: (dir: string) => {
      const names = Object.keys(files)
        .filter((f) => path.dirname(f) === dir)
        .map((f) => path.basename(f))
      if (dir === '/missing') throw new Error('ENOENT')
      return [...names, 'README.md', 'package.json']
    },
    read: (file: string) => files[file] ?? '',
  }

  it('识别常见的许可证文件名，去掉首尾空白', () => {
    expect(findLicenseText('/a', fs)).toBe('MIT License text')
    expect(findLicenseText('/b', fs)).toBe('ISC text')
    expect(findLicenseText('/c', fs)).toBe('BSD text')
  })

  it('没有许可证文件或目录不存在时返回 undefined', () => {
    expect(findLicenseText('/none', fs)).toBeUndefined()
    expect(findLicenseText('/missing', fs)).toBeUndefined()
  })
})

describe('buildNotices', () => {
  it('按名称排序，每个版本一项，附许可证全文', () => {
    const text = buildNotices(
      {
        MIT: [
          {
            name: 'zeta',
            versions: ['1.0.0', '2.0.0'],
            paths: ['/z1', '/z2'],
            license: 'MIT',
            author: 'Z',
            homepage: 'https://z.example',
          },
          { name: '@scope/alpha', versions: ['0.1.0'], paths: ['/a'], license: 'MIT' },
        ],
        'Apache-2.0': [{ name: 'beta', versions: ['3.0.0'], license: 'Apache-2.0' }],
      },
      (dir) => (dir === '/a' ? 'alpha license' : dir === '/z2' ? 'zeta 2 license' : undefined),
    )
    expect(
      text.startsWith('NEXUS-OS includes the following third-party software.\n4 packages.'),
    ).toBe(true)
    const order = ['@scope/alpha@0.1.0', 'beta@3.0.0', 'zeta@1.0.0', 'zeta@2.0.0'].map((k) =>
      text.indexOf(`\n${k}\n`),
    )
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain(
      'zeta@2.0.0\nLicense: MIT\nAuthor: Z\nHomepage: https://z.example\n\nzeta 2 license',
    )
    expect(text).toContain('@scope/alpha@0.1.0\nLicense: MIT\n\nalpha license')
    expect(text).toContain(
      'beta@3.0.0\nLicense: Apache-2.0\n\n(No license file is included in the package.)',
    )
    expect(text.endsWith('\n')).toBe(true)
  })

  it('路径少于版本数时用第一个路径', () => {
    const seen: string[] = []
    buildNotices(
      { MIT: [{ name: 'x', versions: ['1', '2'], paths: ['/x'], license: 'MIT' }] },
      (dir) => {
        seen.push(dir)
        return undefined
      },
    )
    expect(seen).toEqual(['/x', '/x'])
  })
})
