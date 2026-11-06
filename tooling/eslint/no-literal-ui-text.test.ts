import path from 'node:path'
import { ESLint, RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import rule from './no-literal-ui-text.js'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-literal-ui-text', rule, {
  valid: [
    'const a = <p>{t("action.save")}</p>',
    'const a = <p>{count} / {total}</p>',
    'const a = <span>·</span>',
    'const a = <span>100% — 42</span>',
    'const a = <div>  </div>',
    'const a = <input placeholder={t("input.placeholder")} />',
    'const a = <img alt="" />',
    'const a = <div className="flex gap-2" data-testid="session-list" />',
    'const a = <div title={`${name}`} />',
    'const a = <div aria-label />',
    'const a = <Trans i18nKey="welcome" />',
    'const a = <p>{"…"}</p>',
    'const a = <p>{label ?? fallback}</p>',
  ],
  invalid: [
    { code: 'const a = <button>保存</button>', errors: [{ messageId: 'text' }] },
    { code: 'const a = <p>Hello {name}</p>', errors: [{ messageId: 'text' }] },
    { code: "const a = <p>{'Save'}</p>", errors: [{ messageId: 'text' }] },
    { code: 'const a = <>{`Untitled`}</>', errors: [{ messageId: 'text' }] },
    { code: 'const a = <input placeholder="输入消息" />', errors: [{ messageId: 'attribute' }] },
    { code: 'const a = <img alt={"Logo"} />', errors: [{ messageId: 'attribute' }] },
    { code: 'const a = <b title={`Delete`} aria-label="Delete" />', errors: 2 },
  ],
})

describe('配置：只在 renderer 的 JSX 文件中启用', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const eslint = new ESLint({ cwd: root })
  const ruleIds = async (file: string, code: string) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(root, file) })
    return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`)
  }
  const code = 'export const A = () => <p>保存</p>\n'

  it('reports hard-coded text in renderer components', async () => {
    expect(await ruleIds('apps/desktop/src/renderer/App.tsx', code)).toContain(
      'cairn/no-literal-ui-text',
    )
  })

  it.each([
    'apps/desktop/src/renderer/App.test.tsx',
    'apps/desktop/src/main/menu.tsx',
    'packages/ui/src/x.tsx',
  ])('does not apply to %s', async (file) => {
    expect(await ruleIds(file, code)).not.toContain('cairn/no-literal-ui-text')
  })
})
