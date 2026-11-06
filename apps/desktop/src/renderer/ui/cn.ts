/** 合并 className：clsx 处理条件，tailwind-merge 去掉相互覆盖的工具类。 */
import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 自定义的字号令牌（index.css 的 --text-*）要告诉 tailwind-merge，否则 text-ui 会被当成颜色与 text-fg 互相覆盖
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['page', 'dialog', 'heading', 'body', 'ui', 'code', 'term', 'note'] }],
      shadow: [{ shadow: ['1', '2', '3', 'hair', 'hair2'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
