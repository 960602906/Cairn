import path from 'node:path'
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import rule from './no-cross-package-relative.js'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const root = path.resolve('/repo')
const core = (file: string) => path.join(root, 'packages/core/src', file)
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } })

tester.run('no-cross-package-relative', rule, {
  valid: [
    { code: "import x from './a.js'", filename: core('index.ts') },
    { code: "import x from '../index.js'", filename: core('sub/b.ts') },
    { code: "import x from '@cairn/protocol'", filename: core('index.ts') },
    { code: "import fs from 'node:fs'", filename: core('index.ts') },
    { code: 'export const x = 1', filename: core('index.ts') },
    { code: 'const m = "x"; await import(m)', filename: core('index.ts') },
    { code: "await import(`./${'a'}.js`)", filename: core('index.ts') },
    // 不在 workspace 包内的文件（如根目录配置）不受此规则约束。
    { code: "import x from '../outside.js'", filename: path.join(root, 'eslint.config.js') },
    { code: "import x from '../x.js'", filename: path.join(root, 'scripts/check.js') },
    // 名为 packages 的目录本身（没有包名一级）不是包。
    { code: "import x from '../x.js'", filename: path.join(root, 'packages/file.js') },
  ],
  invalid: [
    {
      code: "import x from '../../storage/src/index.js'",
      filename: core('index.ts'),
      errors: [
        { messageId: 'crossPackage', data: { source: '../../storage/src/index.js', pkg: 'core' } },
      ],
    },
    {
      code: "export * from '../../protocol/src/index.js'",
      filename: core('index.ts'),
      errors: [{ messageId: 'crossPackage' }],
    },
    {
      code: "export { a } from '../../protocol/src/a.js'",
      filename: core('index.ts'),
      errors: [{ messageId: 'crossPackage' }],
    },
    {
      code: "await import('../../../apps/desktop/src/main/index.js')",
      filename: core('index.ts'),
      errors: [{ messageId: 'crossPackage' }],
    },
    {
      code: "import x from '../../../../outside.js'",
      filename: core('a/b.ts'),
      errors: [{ messageId: 'crossPackage' }],
    },
    {
      code: "import x from '../../core/src/index.js'",
      filename: path.join(root, 'apps/desktop/src/x.ts'),
      errors: [
        {
          messageId: 'crossPackage',
          data: { source: '../../core/src/index.js', pkg: 'desktop' },
        },
      ],
    },
  ],
})
