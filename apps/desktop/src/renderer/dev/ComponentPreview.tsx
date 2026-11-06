/**
 * 组件预览页（M2-01）：只在开发模式下、地址带 `#preview` 时显示，用来对照参考稿检查令牌与基础组件，
 * 也用于 PR 截图。不进入产品界面，文案不走 i18n。
 */
import { ChevronDown, Copy, MoreHorizontal, Pencil, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Theme } from '@cairn/protocol'
import { applyTheme, type ThemeEnvironment } from '../theme.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Kbd,
  SegmentedControl,
  Shimmer,
  Spinner,
  Switch,
  Tooltip,
  TooltipProvider,
} from '../ui/index.js'

const SWATCHES = [
  'chrome',
  'paper',
  'raise',
  'sunk',
  'sunk2',
  'ink',
  'accent',
  'ok',
  'warn',
  'danger',
  'code-bg',
  'add-bg',
  'del-bg',
  'hunk-bg',
  'term-bg',
] as const

const TEXT = ['fg', 'fg2', 'muted', 'faint'] as const

function Section({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-heading">{title}</h2>
      {children}
    </section>
  )
}

export function ComponentPreview({
  initialTheme = 'system',
  env,
}: {
  readonly initialTheme?: Theme
  readonly env?: ThemeEnvironment
}) {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [enabled, setEnabled] = useState(true)
  useEffect(() => applyTheme(theme, env), [theme, env])

  return (
    <TooltipProvider>
      <div className="flex h-full bg-chrome">
        <aside className="flex w-[252px] shrink-0 flex-col gap-0.5 p-2 pt-11 text-ui text-fg2">
          <div className="flex h-8 items-center gap-2 rounded-item bg-raise px-2.5 font-medium text-fg shadow-1">
            <Pencil className="size-4 text-muted" />
            新对话
            <Kbd className="ml-auto">Ctrl N</Kbd>
          </div>
          <div className="flex h-8 items-center gap-2 rounded-item px-2.5 hover:bg-hover">
            <Spinner label="运行中" />
            修复 sum 的 bug
          </div>
          <div className="flex h-8 items-center gap-2 rounded-item px-2.5 hover:bg-hover">
            <span className="size-1.5 rounded-full bg-faint" />
            整理 README
          </div>
        </aside>
        <main className="my-2 mr-2 flex-1 overflow-auto rounded-paper bg-paper shadow-1">
          <div className="mx-auto max-w-[700px] px-7 py-10">
            <div className="mb-8 flex items-center justify-between">
              <h1 className="text-page">组件预览</h1>
              <SegmentedControl
                label="主题"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
            </div>

            <Section title="颜色令牌">
              <div className="grid grid-cols-5 gap-2">
                {SWATCHES.map((name) => (
                  <div key={name} className="text-note text-muted">
                    <div
                      className="mb-1 h-10 rounded-item shadow-hair2"
                      style={{ background: `var(--${name})` }}
                    />
                    {name}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-4">
                {TEXT.map((name) => (
                  <span key={name} style={{ color: `var(--${name})` }}>
                    --{name} 正文文字
                  </span>
                ))}
              </div>
            </Section>

            <Section title="文字">
              <p className="text-body text-fg">
                对话正文 15px / 1.78。行内代码{' '}
                <code className="rounded-[5px] bg-sunk px-1.5 py-0.5 font-mono text-[13px]">
                  src/sum.mjs
                </code>
                ，箭头不连字：<code className="font-mono">{'() => a !== b'}</code>。
              </p>
              <p className="tabular text-note text-muted">12,480 tokens · 第 3 轮</p>
            </Section>

            <Section title="按钮">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">运行一次</Button>
                <Button>取消</Button>
                <Button variant="ghost">
                  <Copy />
                  复制
                </Button>
                <Button variant="danger">撤销 2 个文件</Button>
                <Button disabled>不可用</Button>
                <Tooltip content="更多">
                  <IconButton label="更多">
                    <MoreHorizontal />
                  </IconButton>
                </Tooltip>
              </div>
            </Section>

            <Section title="控件">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-ui">
                  <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用" />
                  启用
                </label>
                <span className="flex items-center gap-2 text-ui">
                  <Spinner label="运行中" />
                  <Shimmer>正在读取 src/sum.mjs</Shimmer>
                </span>
                <span className="text-ui text-muted">
                  按 <Kbd>Esc</Kbd> 停止
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost">
                      DeepSeek · V4.1 Flash
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuLabel>会话</DropdownMenuLabel>
                    <DropdownMenuItem>
                      <Pencil />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem tone="danger">
                      <Trash2 />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Section>

            <Section title="卡片与对话框">
              <div className="mb-4 rounded-approval bg-raise p-4 shadow-2">
                <div className="text-[14px] font-semibold">要运行这条命令吗？</div>
                <pre className="mt-2 rounded-item bg-sunk px-3 py-2 font-mono text-code">
                  node --test
                </pre>
              </div>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>打开撤销确认框</Button>
                </DialogTrigger>
                <DialogContent tone="danger" icon={<TriangleAlert />}>
                  <DialogTitle>撤销第 3 轮的改动？</DialogTitle>
                  <DialogDescription>
                    工作区会回到这一轮开始之前，下面的文件会被恢复或删除。对话记录保留。
                  </DialogDescription>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button>取消</Button>
                    </DialogClose>
                    <Button variant="danger">撤销 2 个文件</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </Section>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
