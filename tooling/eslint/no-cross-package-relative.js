// @ts-check
/**
 * 禁止用相对路径跨包引用（如 `../../core/src/x`），跨包必须通过 `@cairn/*` 包名，
 * 这样依赖关系才会出现在 package.json 中并受边界规则约束（ADR-0015）。
 */
import path from 'node:path'

const WORKSPACE_DIRS = ['packages', 'apps']

/**
 * 返回文件所在的包根目录（如 /repo/packages/core），不在 workspace 包内时返回 undefined。
 * @param {string} file
 * @returns {string | undefined}
 */
function packageRootOf(file) {
  const parts = path.resolve(file).split(path.sep)
  // 包目录（packages / apps）之后至少还要有包名和文件名两级，因此从倒数第三级开始找。
  for (let i = parts.length - 3; i >= 0; i--) {
    if (WORKSPACE_DIRS.includes(/** @type {string} */ (parts[i]))) {
      return parts.slice(0, i + 2).join(path.sep)
    }
  }
  return undefined
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow relative imports that cross workspace package boundaries' },
    messages: {
      crossPackage:
        'Relative import "{{source}}" leaves package "{{pkg}}". Import other packages by their @cairn/* name.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename
    const maybeRoot = packageRootOf(filename)
    if (!maybeRoot) return {}
    const root = maybeRoot

    /**
     * @param {import('eslint').Rule.Node} node
     */
    function check(node) {
      const source = /** @type {{ source?: { value?: unknown } | null }} */ (node).source
      if (!source || typeof source.value !== 'string' || !source.value.startsWith('.')) return
      const target = path.resolve(path.dirname(filename), source.value)
      const rel = path.relative(root, target)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        context.report({
          node,
          messageId: 'crossPackage',
          data: { source: source.value, pkg: path.basename(root) },
        })
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    }
  },
}
