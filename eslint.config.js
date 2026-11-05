// @ts-check
import { builtinModules } from 'node:module'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCrossPackageRelative from './tooling/eslint/no-cross-package-relative.js'
import noLiteralUiText from './tooling/eslint/no-literal-ui-text.js'

/**
 * 依赖边界（ADR-0015，架构 §5）：每个包允许引用的 @nexus/* 包。
 * 新建包时必须在这里登记，否则它不能引用任何 @nexus/* 包。
 * 依赖方向自上而下，禁止反向引用。
 */
const ALLOWED_NEXUS_DEPS = {
  'packages/protocol': [],
  'packages/core': ['protocol'],
  'packages/storage': ['protocol', 'core'],
  'packages/i18n': [],
  'packages/runtime-pi': ['protocol', 'core'],
  'packages/tools': ['protocol', 'core', 'shell'],
  'packages/shell': [],
  'apps/desktop': ['protocol', 'core', 'storage', 'i18n', 'runtime-pi', 'tools'],
}

/** 只有 runtime-pi 可以引用 pi（ADR-0004）。包含旧的包作用域。 */
const PI_PACKAGES = '^@(earendil-works|mariozechner)/'
const PI_OWNER = 'packages/runtime-pi'

/** 渲染进程没有任何 Node 能力（架构 §3、§17）。 */
const NODE_BUILTINS = builtinModules.filter((m) => !m.startsWith('_'))

/**
 * @param {string} pkg
 * @param {{ extraPatterns?: { regex: string, message: string }[] }} [extra]
 * @returns {import('eslint').Linter.RuleEntry}
 */
function restrictedImports(pkg, extra = {}) {
  const allowed = ALLOWED_NEXUS_DEPS[/** @type {keyof typeof ALLOWED_NEXUS_DEPS} */ (pkg)] ?? []
  const nexusRegex = allowed.length ? `^@nexus/(?!(${allowed.join('|')})$)` : '^@nexus/'
  /** @type {{ regex: string, message: string }[]} */
  const patterns = [
    {
      regex: nexusRegex,
      message: `Dependency boundary: ${pkg} may only import @nexus/{${allowed.join(',')}} (see eslint.config.js ALLOWED_NEXUS_DEPS).`,
    },
  ]
  if (pkg !== PI_OWNER) {
    patterns.push({
      regex: PI_PACKAGES,
      message:
        'Only packages/runtime-pi may import pi (ADR-0004). Use the AgentRuntime interface from @nexus/core.',
    })
  }
  if (pkg.startsWith('packages/')) {
    patterns.push({
      regex: '^electron$',
      message: 'Library packages must not depend on Electron; only apps/desktop may.',
    })
  }
  patterns.push(...(extra.extraPatterns ?? []))
  return ['error', { patterns }]
}

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      nexus: {
        rules: {
          'no-cross-package-relative': noCrossPackageRelative,
          'no-literal-ui-text': noLiteralUiText,
        },
      },
    },
    rules: {
      'nexus/no-cross-package-relative': 'error',
      // 所有文件（含 JS，经 checkJs）都由 tsc 检查未定义变量，no-undef 会对 Node 全局变量误报。
      'no-undef': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  ...Object.keys(ALLOWED_NEXUS_DEPS).map((pkg) => ({
    files: [`${pkg}/**/*.{ts,tsx,js,mjs}`],
    rules: { 'no-restricted-imports': restrictedImports(pkg) },
  })),
  {
    // 界面文案一律走 i18n（ADR-0013）；测试文件除外
    files: ['apps/desktop/src/renderer/**/*.{tsx,jsx}'],
    ignores: ['**/*.test.{tsx,jsx}'],
    rules: { 'nexus/no-literal-ui-text': 'error' },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx,js}'],
    rules: {
      'no-restricted-imports': restrictedImports('apps/desktop', {
        extraPatterns: [
          {
            regex: `^(node:.*|${NODE_BUILTINS.map((m) => m.replace(/[/]/g, '\\/')).join('|')})$`,
            message:
              'The renderer has no Node access. Use the typed API exposed by the preload script.',
          },
          {
            regex: '^@nexus/runtime-pi$',
            message: 'The renderer must not import the model runtime. It runs in the agent host.',
          },
          {
            regex: '^@nexus/tools$',
            message: 'The renderer must not import tools. They run in the agent host.',
          },
          {
            regex: '^electron(\\/.*)?$',
            message:
              'The renderer must not import Electron. Use the typed API exposed by the preload script.',
          },
        ],
      }),
    },
  },
)
