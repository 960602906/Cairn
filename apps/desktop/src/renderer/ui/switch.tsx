/**
 * 开关：约 24×14 的安静胶囊。打开时轨道铺品牌色（深色鸢尾 / 浅色近黑），白色滑块靠右；
 * 关闭时用更深的沉底色（深色 `--sunk`、浅色 `--sunk2`），滑块靠左。无渐变、无厚阴影。
 */
import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from './cn.js'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full bg-sunk2 p-px transition-colors disabled:opacity-45 dark:bg-sunk',
        'data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-3 rounded-full bg-white transition-transform',
          'data-[state=checked]:translate-x-2.5',
        )}
      />
    </SwitchPrimitive.Root>
  )
}
