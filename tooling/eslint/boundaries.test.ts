import path from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const eslint = new ESLint({ cwd: root })

/** 以给定的仓库内路径检查一段代码，返回触发的规则 id 列表。 */
async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) })
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`)
}

const BOUNDARY = 'no-restricted-imports'
const RELATIVE = 'nexus/no-cross-package-relative'

describe('依赖边界（ADR-0015）', () => {
  it.each([
    ['packages/protocol/src/x.ts', "import '@nexus/core'"],
    ['packages/protocol/src/x.ts', "import '@nexus/storage'"],
    ['packages/core/src/x.ts', "import '@nexus/storage'"],
    ['packages/core/src/x.ts', "import '@nexus/desktop'"],
    ['packages/storage/src/x.ts', "import '@nexus/desktop'"],
    ['packages/i18n/src/x.ts', "import '@nexus/core'"],
  ])('%s 禁止 %s', async (file, code) => {
    expect(await ruleIds(file, code)).toContain(BOUNDARY)
  })

  it.each([
    ['packages/core/src/x.ts', "import '@nexus/protocol'"],
    ['packages/storage/src/x.ts', "import '@nexus/core'"],
    ['apps/desktop/src/main/x.ts', "import '@nexus/storage'"],
    ['apps/desktop/src/main/x.ts', "import 'electron'"],
  ])('%s 允许 %s', async (file, code) => {
    expect(await ruleIds(file, code)).toEqual([])
  })

  it('不允许前缀相同的包名绕过（@nexus/protocol-x 不等于 @nexus/protocol）', async () => {
    expect(await ruleIds('packages/core/src/x.ts', "import '@nexus/protocol-x'")).toContain(
      BOUNDARY,
    )
  })
})

describe('只有 runtime-pi 可以引用 pi（ADR-0004）', () => {
  it.each(['@earendil-works/pi-ai', '@mariozechner/pi-agent-core'])('core 禁止 %s', async (mod) => {
    expect(await ruleIds('packages/core/src/x.ts', `import '${mod}'`)).toContain(BOUNDARY)
  })

  it('apps/desktop 禁止引用 pi', async () => {
    expect(await ruleIds('apps/desktop/src/main/x.ts', "import '@earendil-works/pi-ai'")).toContain(
      BOUNDARY,
    )
  })
})

describe('库包不依赖 Electron', () => {
  it('core 禁止 electron', async () => {
    expect(await ruleIds('packages/core/src/x.ts', "import 'electron'")).toContain(BOUNDARY)
  })
})

describe('渲染进程没有 Node 能力（架构 §17）', () => {
  it.each(['node:fs', 'fs', 'child_process', 'fs/promises', 'electron', 'electron/renderer'])(
    '禁止 %s',
    async (mod) => {
      expect(await ruleIds('apps/desktop/src/renderer/x.tsx', `import '${mod}'`)).toContain(
        BOUNDARY,
      )
    },
  )

  it('仍然遵守 desktop 的 @nexus 依赖范围', async () => {
    expect(await ruleIds('apps/desktop/src/renderer/x.tsx', "import '@nexus/core'")).toEqual([])
    expect(await ruleIds('apps/desktop/src/renderer/x.tsx', "import '@nexus/foo'")).toContain(
      BOUNDARY,
    )
  })
})

describe('禁止用相对路径跨包引用', () => {
  it.each([
    "import '../../storage/src/index.js'",
    "export * from '../../protocol/src/index.js'",
    "await import('../../../apps/desktop/src/main/index.js')",
  ])('core 中 %s', async (code) => {
    expect(await ruleIds('packages/core/src/x.ts', code)).toContain(RELATIVE)
  })

  it('包内相对引用允许', async () => {
    expect(await ruleIds('packages/core/src/a/b.ts', "import '../index.js'")).toEqual([])
  })
})
