// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
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
  PanelEmpty,
  SegmentedControl,
  Shimmer,
  Spinner,
  Switch,
  Tooltip,
  TooltipProvider,
} from './index.js'

afterEach(cleanup)

describe('cn', () => {
  it('merges conflicting utilities, keeping custom font sizes apart from colors', () => {
    expect(cn('px-2', false, 'px-3')).toBe('px-3')
    expect(cn('text-ui text-fg', 'text-muted')).toBe('text-ui text-muted')
    expect(cn('text-ui', 'text-body')).toBe('text-body')
    expect(cn('shadow-1', 'shadow-2')).toBe('shadow-2')
  })
})

describe('Button', () => {
  it('renders a typed button with variant classes and handles clicks', async () => {
    const onClick = vi.fn()
    render(
      <Button variant="primary" onClick={onClick}>
        Send
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Send' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).toContain('bg-ink')
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('keeps an explicit type and can render as its child', () => {
    render(
      <>
        <Button type="submit">Save</Button>
        <Button asChild variant="ghost">
          <a href="#x">Link</a>
        </Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('submit')
    const link = screen.getByRole('link', { name: 'Link' })
    expect(link.getAttribute('type')).toBeNull()
    expect(link.className).toContain('hover:bg-hover')
  })

  it('labels icon-only buttons', () => {
    render(<IconButton label="Copy">*</IconButton>)
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button.getAttribute('title')).toBe('Copy')
  })
})

describe('small pieces', () => {
  it('renders a panel empty state with and without icon and hint', () => {
    const view = render(<PanelEmpty>还没有内容</PanelEmpty>)
    expect(screen.getByText('还没有内容')).toBeTruthy()
    expect(view.container.querySelector('[aria-hidden]')).toBeNull()
    view.unmount()

    render(
      <PanelEmpty icon={<svg data-testid="empty-icon" />} hint="稍后再来" className="px-2">
        还没有内容
      </PanelEmpty>,
    )
    expect(screen.getByTestId('empty-icon')).toBeTruthy()
    expect(screen.getByText('稍后再来')).toBeTruthy()
  })

  it('renders Kbd, Spinner and Shimmer', () => {
    render(
      <>
        <Kbd>Esc</Kbd>
        <Spinner label="Running" />
        <Shimmer>Reading</Shimmer>
      </>,
    )
    expect(screen.getByText('Esc').tagName).toBe('KBD')
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy()
    expect(screen.getByText('Reading').className).toContain('animate-shimmer')
  })

  it('toggles a Switch', async () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Enabled" onCheckedChange={onCheckedChange} />)
    await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})

describe('SegmentedControl', () => {
  function Themes() {
    const [value, setValue] = useState<'system' | 'light' | 'dark'>('system')
    return (
      <SegmentedControl
        label="Theme"
        value={value}
        onChange={setValue}
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
    )
  }

  it('selects by click and arrow keys, wrapping around', async () => {
    render(<Themes />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(group).toBeTruthy()
    const checked = () => screen.getByRole('radio', { checked: true }).textContent
    expect(checked()).toBe('System')
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(checked()).toBe('Dark')
    await userEvent.keyboard('{ArrowRight}')
    expect(checked()).toBe('System')
    expect(document.activeElement?.textContent).toBe('System')
    await userEvent.keyboard('{ArrowLeft}')
    expect(checked()).toBe('Dark')
    await userEvent.keyboard('a')
    expect(checked()).toBe('Dark')
  })
})

describe('Dialog', () => {
  it('opens with title, description and footer; Esc closes it', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Undo</Button>
        </DialogTrigger>
        <DialogContent tone="danger" icon={<span>!</span>}>
          <DialogTitle>Undo turn 3?</DialogTitle>
          <DialogDescription>Files will be restored.</DialogDescription>
          <DialogFooter>
            <Button>Cancel</Button>
            <Button variant="danger">Undo 2 files</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    const dialog = screen.getByRole('dialog', { name: 'Undo turn 3?' })
    expect(dialog.textContent).toContain('Files will be restored.')
    expect(screen.getByText('!').parentElement?.className).toContain('text-danger')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('uses a neutral icon tile by default', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent icon={<span>i</span>} aria-describedby={undefined}>
          <DialogTitle>Info</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText('i').parentElement?.className).toContain('bg-sunk')
  })
})

describe('DropdownMenu', () => {
  it('opens and selects an item', async () => {
    const onRename = vi.fn()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>More</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('text-danger')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledOnce()
  })
})

describe('Collapsible', () => {
  it('toggles the content and reports the open state on the trigger', async () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>思考过程</CollapsibleTrigger>
        <CollapsibleContent>正文</CollapsibleContent>
      </Collapsible>,
    )
    const trigger = screen.getByRole('button', { name: '思考过程' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await userEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the content mounted when asked, collapsing it by height', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>思考过程</CollapsibleTrigger>
        <CollapsibleContent forceMount>正文</CollapsibleContent>
      </Collapsible>,
    )
    // 收起时正文仍在 DOM 里（流式内容与读屏文本不因开合丢失），靠高度收住
    const content = screen.getByText('正文')
    expect(content.getAttribute('data-state')).toBe('closed')
    expect(content.className).toContain('data-[state=closed]:h-0')
  })
})

describe('Tooltip', () => {
  it('shows content on focus', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Context 42%" side="bottom">
          <button type="button">ring</button>
        </Tooltip>
      </TooltipProvider>,
    )
    await userEvent.tab()
    expect((await screen.findAllByText('Context 42%')).length).toBeGreaterThan(0)
  })
})
