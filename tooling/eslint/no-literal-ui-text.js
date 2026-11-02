// @ts-check
/**
 * 禁止在界面（renderer）的 JSX 中硬编码文案（ADR-0013，架构 §19）。文案一律通过 i18n key 引用。
 *
 * 报告：
 * - 含字母或汉字的 JSX 文本，如 `<p>保存</p>`；
 * - 作为子节点的字符串字面量或无插值模板字符串，如 `<p>{'Save'}</p>`；
 * - 面向用户的属性写成字符串，如 `title="Save"`、`placeholder`、`alt`、`aria-label`、`label`。
 *
 * 只含空白、数字、标点或符号的文本（如 `·`、`/`、`100%`）不报告。
 */

/** 面向用户、需要翻译的属性。 */
const TEXT_ATTRIBUTES = new Set([
  'title',
  'placeholder',
  'alt',
  'label',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
])

/** 含字母（任意文字，包括汉字）的文本才需要翻译。 */
const HAS_LETTER = /\p{L}/u

/**
 * @param {string} text
 * @returns {boolean}
 */
function needsTranslation(text) {
  return HAS_LETTER.test(text)
}

/**
 * 字符串字面量或无插值的模板字符串的内容；其他表达式返回 undefined。
 * @param {any} node ESTree 表达式
 * @returns {string | undefined}
 */
function staticText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((/** @type {any} */ q) => q.value.cooked ?? q.value.raw).join('')
  }
  return undefined
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hard-coded UI text in JSX; use i18n keys (ADR-0013)' },
    schema: [],
    messages: {
      text: 'Hard-coded UI text "{{text}}". Use a translation key from @nexus/i18n (ADR-0013).',
      attribute:
        'Hard-coded text in "{{name}}" attribute. Use a translation key from @nexus/i18n (ADR-0013).',
    },
  },
  create(context) {
    /**
     * @param {import('eslint').Rule.Node} node
     * @param {string} text
     */
    const reportText = (node, text) => {
      context.report({ node, messageId: 'text', data: { text: text.trim().slice(0, 40) } })
    }

    return {
      /** @param {any} node JSXText */
      JSXText(node) {
        if (needsTranslation(node.value)) reportText(node, node.value)
      },
      /** @param {any} node JSXExpressionContainer */
      JSXExpressionContainer(node) {
        // 只看作为子节点的表达式；属性值由 JSXAttribute 处理
        if (node.parent?.type !== 'JSXElement' && node.parent?.type !== 'JSXFragment') return
        const text = staticText(node.expression)
        if (text !== undefined && needsTranslation(text)) reportText(node, text)
      },
      /** @param {any} node JSXAttribute */
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || !TEXT_ATTRIBUTES.has(node.name.name)) return
        const value = node.value
        if (!value) return
        const text =
          value.type === 'JSXExpressionContainer' ? staticText(value.expression) : staticText(value)
        if (text !== undefined && needsTranslation(text)) {
          context.report({ node, messageId: 'attribute', data: { name: node.name.name } })
        }
      },
    }
  },
}
