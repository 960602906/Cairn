// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { PermissionRule, PermissionRuleEntry, Settings, SettingsPatch } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'

afterEach(cleanup)

const PROJECT = { projectId: 'p1', name: 'sample-project', path: '/work/sample', createdAt: 1 }

const approved: PermissionRuleEntry = {
  rule: {
    id: 'a1',
    scope: 'project',
    effect: 'allow',
    match: { tool: 'run_command', command: ['node --test *'] },
    source: 'approval',
  },
  projectId: 'p1',
  createdAt: 1,
}
const manual: PermissionRuleEntry = {
  rule: {
    id: 'u1',
    scope: 'global',
    effect: 'ask',
    match: { tool: 'run_command', command: ['git commit *'] },
    source: 'user',
  },
  createdAt: 2,
}

function setup(
  initial: Partial<Settings> = {},
  rules: PermissionRuleEntry[] = [],
  options: { failList?: boolean; failDelete?: boolean; failAdd?: boolean } = {},
) {
  let settings: Settings = { locale: 'zh-CN', providers: [], ...initial }
  let stored = [...rules]
  const updates: SettingsPatch[] = []
  const request = vi.fn(async (method: string, params: never) => {
    switch (method) {
      case 'settings.get':
        return settings
      case 'settings.update': {
        const patch = params as SettingsPatch
        updates.push(patch)
        settings = { ...settings, ...patch } as Settings
        return settings
      }
      case 'settings.shell':
        return { detected: 'bash', options: ['auto'] }
      case 'permissions.list':
        if (options.failList) throw new Error('list failed')
        return { rules: stored }
      case 'permissions.add': {
        if (options.failAdd) return undefined
        const { rule, projectId } = params as { rule: PermissionRule; projectId?: string }
        const entry = { rule, ...(projectId ? { projectId } : {}), createdAt: 3 }
        stored = [...stored, entry]
        return entry
      }
      case 'permissions.delete': {
        if (options.failDelete) return undefined
        const { ruleId } = params as { ruleId: string }
        stored = stored.filter((e) => e.rule.id !== ruleId)
        return {}
      }
      case 'session.list':
        return { sessions: [] }
      case 'project.list':
        return { projects: [PROJECT] }
      default:
        return {}
    }
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  render(<App i18n={createI18n('zh-CN')} store={createSessionStore(api)} />)
  return { request, updates, stored: () => stored }
}

const open = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /^设置/ }))
  const nav = await screen.findByRole('navigation', { name: '设置分类' })
  await userEvent.click(within(nav).getByRole('button', { name: '权限与审批' }))
  return screen.findByRole('heading', { name: '权限与审批' })
}

const rules = () => screen.getByRole('list', { name: '权限规则' })

describe('PermissionsSettings', () => {
  it('switches the permission mode and shows its built-in rules', async () => {
    const { updates } = setup()
    await open()
    const modes = screen.getByRole('radiogroup', { name: '权限模式' })
    expect(within(modes).getByRole('radio', { name: /^询问/ }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(await screen.findByText(/还没有规则/)).toBeTruthy()

    await userEvent.click(within(modes).getByRole('radio', { name: /^自动/ }))
    await waitFor(() => expect(updates).toEqual([{ permissionMode: 'auto' }]))
    const items = within(rules()).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      '允许写入类工具内置 · 自动模式',
      '允许执行命令内置 · 自动模式',
      '允许联网内置 · 自动模式',
    ])
    // 内置规则不能删除
    expect(within(rules()).queryByRole('button')).toBeNull()

    await userEvent.click(within(modes).getByRole('radio', { name: /^只读/ }))
    expect(within(rules()).getAllByText('拒绝')).toHaveLength(3)
    // 已选中的模式不重复保存
    await userEvent.click(within(modes).getByRole('radio', { name: /^只读/ }))
    expect(updates).toHaveLength(2)
  })

  it('lists saved rules with their source and scope, and deletes them', async () => {
    const { request, stored } = setup({}, [approved, manual])
    await open()
    await waitFor(() => expect(within(rules()).getAllByRole('listitem')).toHaveLength(2))
    const [first, second] = within(rules()).getAllByRole('listitem')
    expect(first!.textContent).toBe(
      '允许run_command: node --test *在审批卡片中添加 · sample-project',
    )
    expect(second!.textContent).toBe('询问run_command: git commit *手动添加 · 全局')

    await userEvent.click(
      screen.getByRole('button', { name: '删除规则：run_command: node --test *' }),
    )
    expect(request).toHaveBeenCalledWith('permissions.delete', { ruleId: 'a1' })
    await waitFor(() => expect(within(rules()).getAllByRole('listitem')).toHaveLength(1))
    expect(stored().map((e) => e.rule.id)).toEqual(['u1'])
  })

  it('adds a manual rule for a project', async () => {
    const { request } = setup()
    await open()
    await userEvent.click(screen.getByRole('button', { name: '添加规则' }))
    const form = screen.getByRole('region', { name: '添加规则' })
    await userEvent.click(within(form).getByRole('radio', { name: '拒绝' }))
    await userEvent.selectOptions(within(form).getByLabelText('工具'), 'read_file')
    await userEvent.type(within(form).getByLabelText('路径'), ' secrets/** ')
    await userEvent.selectOptions(within(form).getByLabelText('范围'), 'p1')
    await userEvent.click(within(form).getByRole('button', { name: '添加' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('permissions.add', {
        rule: {
          id: expect.stringMatching(/^user\./),
          scope: 'project',
          effect: 'deny',
          match: { tool: 'read_file', path: ['secrets/**'] },
          source: 'user',
        },
        projectId: 'p1',
      }),
    )
    expect(screen.queryByRole('region', { name: '添加规则' })).toBeNull()
    expect(within(rules()).getByRole('listitem').textContent).toBe(
      '拒绝read_file: secrets/**手动添加 · sample-project',
    )
  })

  it('requires a path for rules on any tool and can be cancelled', async () => {
    const { request } = setup()
    await open()
    await userEvent.click(screen.getByRole('button', { name: '添加规则' }))
    const form = screen.getByRole('region', { name: '添加规则' })
    // 默认是运行命令，留空匹配所有命令
    expect(within(form).getByLabelText('命令')).toBeTruthy()
    await userEvent.selectOptions(within(form).getByLabelText('工具'), '*')
    expect(within(form).getByText(/要填写路径/)).toBeTruthy()
    const add = within(form).getByRole('button', { name: '添加' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    await userEvent.type(within(form).getByLabelText('路径'), '**/.env*')
    expect(add.disabled).toBe(false)
    await userEvent.click(within(form).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('region', { name: '添加规则' })).toBeNull()
    expect(request).not.toHaveBeenCalledWith('permissions.add', expect.anything())
  })

  it('describes wildcard path rules, unknown projects, and survives a failed list', async () => {
    const wildcard: PermissionRuleEntry = {
      rule: {
        id: 'w1',
        scope: 'project',
        effect: 'allow',
        match: { path: ['src/**'] },
        source: 'user',
      },
      projectId: 'gone',
      createdAt: 4,
    }
    setup({}, [wildcard])
    await open()
    await waitFor(() => expect(within(rules()).getAllByRole('listitem')).toHaveLength(1))
    const row = within(rules()).getAllByRole('listitem')[0]!
    expect(row.textContent).toContain('任意工具: src/**')
    expect(row.textContent).toContain('已移除的项目')
    cleanup()

    setup({}, [], { failList: true })
    await open()
    expect(await screen.findByText(/还没有规则/)).toBeTruthy()
  })

  it('keeps rules and the form when add or delete fails', async () => {
    const { request } = setup({}, [manual], { failDelete: true })
    await open()
    await waitFor(() => expect(within(rules()).getAllByRole('listitem')).toHaveLength(1))
    await userEvent.click(
      screen.getByRole('button', { name: '删除规则：run_command: git commit *' }),
    )
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('permissions.delete', { ruleId: 'u1' }),
    )
    expect(within(rules()).getAllByRole('listitem')).toHaveLength(1)
    cleanup()

    const add = setup({}, [], { failAdd: true })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '添加规则' }))
    const form = screen.getByRole('region', { name: '添加规则' })
    await userEvent.click(within(form).getByRole('button', { name: '添加' }))
    await waitFor(() =>
      expect(add.request).toHaveBeenCalledWith('permissions.add', expect.anything()),
    )
    expect(screen.getByRole('region', { name: '添加规则' })).toBeTruthy()
  })
})
