/**
 * 权限引擎（M1-10a）：判定顺序的每一步、规则匹配、预设与审批生成的规则。
 */
import { PermissionRule as PermissionRuleSchema, type PermissionRule } from '@nexus/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  approvalRule,
  CATEGORY_DEFAULTS,
  createPermissionEngine,
  decidePermission,
  PermissionReasonCode,
  presetRules,
  type PermissionGuard,
} from './permissions.js'
import type { PermissionRequest } from './tool-pipeline.js'
import type { ToolCategory, ToolDefinition, ToolTargets, ToolTrust } from './tools.js'

const def = (
  name: string,
  category: ToolCategory,
  trust: ToolTrust = 'builtin',
): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  category,
  source: { kind: 'builtin' },
  trust,
  execute: () => Promise.resolve({ content: [] }),
})

const tools = {
  read: def('read_file', 'read'),
  write: def('write_file', 'write'),
  run: def('run_command', 'execute'),
  fetch: def('fetch', 'network'),
  task: def('task', 'delegate'),
  mcpRead: def('mcp_read', 'read', 'third-party'),
}

const req = (definition: ToolDefinition, targets: ToolTargets = {}): PermissionRequest => ({
  toolCallId: 'call-1',
  definition,
  input: {},
  targets,
})

let n = 0
const rule = (
  effect: PermissionRule['effect'],
  match: PermissionRule['match'],
  scope: PermissionRule['scope'] = 'project',
): PermissionRule => ({ id: `r${++n}`, scope, effect, match, source: 'user' })

describe('类别默认值（没有规则匹配）', () => {
  it.each([
    [tools.read, 'allow'],
    [tools.task, 'allow'],
    [tools.write, 'ask'],
    [tools.run, 'ask'],
    [tools.fetch, 'ask'],
    [tools.mcpRead, 'ask'],
  ] as const)('%s', (definition, expected) => {
    expect(decidePermission(req(definition), []).decision).toBe(expected)
  })

  it('理由码', () => {
    expect(decidePermission(req(tools.write), [])).toEqual({
      decision: 'ask',
      reasonCode: PermissionReasonCode.CategoryDefault,
      matchedRuleIds: [],
    })
    expect(decidePermission(req(tools.mcpRead), [])).toMatchObject({
      reasonCode: PermissionReasonCode.ThirdPartyTool,
    })
    expect(CATEGORY_DEFAULTS.read).toBe('allow')
  })
})

describe('规则：deny > ask > allow', () => {
  const allow = rule('allow', { tool: 'write_file' })
  const ask = rule('ask', { category: ['write'] })
  const deny = rule('deny', { path: ['**/.env*'] })

  it('取最严格的结果，给出匹配的规则', () => {
    expect(decidePermission(req(tools.write, { paths: ['src/a.ts'] }), [allow])).toEqual({
      decision: 'allow',
    })
    expect(decidePermission(req(tools.write, { paths: ['src/a.ts'] }), [allow, ask])).toEqual({
      decision: 'ask',
      reasonCode: PermissionReasonCode.RuleRequiresApproval,
      matchedRuleIds: [ask.id],
    })
    expect(decidePermission(req(tools.write, { paths: ['.env'] }), [allow, ask, deny])).toEqual({
      decision: 'deny',
      reasonCode: PermissionReasonCode.DeniedByRule,
      matchedRuleIds: [deny.id],
      reason: expect.stringContaining('not allowed') as unknown as string,
    })
  })

  it('低范围的 allow 不能覆盖高范围的 deny', () => {
    const globalDeny = rule('deny', { tool: 'run_command' }, 'global')
    const sessionAllow = rule('allow', { tool: 'run_command' }, 'session')
    expect(
      decidePermission(req(tools.run, { command: 'ls' }), [globalDeny, sessionAllow]).decision,
    ).toBe('deny')
  })

  it('规则可以放宽类别默认值，也可以收紧', () => {
    expect(
      decidePermission(req(tools.run, { command: 'npm test' }), [
        rule('allow', { command: ['npm test'] }),
      ]).decision,
    ).toBe('allow')
    expect(
      decidePermission(req(tools.read, { paths: ['a'] }), [rule('ask', { tool: ['read_file'] })])
        .decision,
    ).toBe('ask')
    // 匹配所有调用的规则
    expect(decidePermission(req(tools.fetch), [rule('allow', {})]).decision).toBe('allow')
  })
})

describe('规则匹配', () => {
  it.each<[string, PermissionRule['match'], PermissionRequest, boolean]>([
    ['tool 字符串', { tool: 'write_file' }, req(tools.write), true],
    ['tool 数组', { tool: ['read_file', 'write_file'] }, req(tools.write), true],
    ['tool 不同', { tool: 'read_file' }, req(tools.write), false],
    ['category', { category: ['write', 'execute'] }, req(tools.run), true],
    ['category 不同', { category: ['read'] }, req(tools.run), false],
    [
      'path：allow 要求全部匹配',
      { path: ['src/**'] },
      req(tools.write, { paths: ['src/a', 'b'] }),
      false,
    ],
    [
      'path：全部匹配',
      { path: ['src/**', 'b'] },
      req(tools.write, { paths: ['src/a', 'b'] }),
      true,
    ],
    ['path：没有路径', { path: ['**'] }, req(tools.write), false],
    ['command：没有命令', { command: ['*'] }, req(tools.write), false],
    [
      'command：每段都匹配',
      { command: ['npm *'] },
      req(tools.run, { command: 'npm i && npm t' }),
      true,
    ],
    [
      'command：有一段不匹配',
      { command: ['npm *'] },
      req(tools.run, { command: 'npm i; curl x' }),
      false,
    ],
    [
      'command：命令替换',
      { command: ['echo *'] },
      req(tools.run, { command: 'echo $(id)' }),
      false,
    ],
    [
      '多项同时满足',
      { tool: 'run_command', command: ['ls'] },
      req(tools.run, { command: 'ls' }),
      true,
    ],
    [
      '多项之一不满足',
      { tool: 'write_file', command: ['ls'] },
      req(tools.run, { command: 'ls' }),
      false,
    ],
  ])('allow %s', (_, match, request, expected) => {
    expect(decidePermission(request, [rule('allow', match)]).decision === 'allow').toBe(expected)
  })

  it('deny / ask 任一路径或任一段命令匹配即可', () => {
    const deny = [rule('deny', { path: ['**/.env*'] }), rule('deny', { command: ['rm -rf*'] })]
    expect(decidePermission(req(tools.write, { paths: ['a.ts', 'x/.env'] }), deny).decision).toBe(
      'deny',
    )
    expect(decidePermission(req(tools.run, { command: 'ls; rm -rf /' }), deny).decision).toBe(
      'deny',
    )
    expect(decidePermission(req(tools.run, { command: 'echo $(rm -rf /)' }), deny).decision).toBe(
      'ask',
    )
  })

  it('不区分大小写（Windows）', () => {
    const deny = [rule('deny', { path: ['**/.env'] })]
    const request = req(tools.write, { paths: ['A/.ENV'] })
    expect(decidePermission(request, deny).decision).toBe('ask')
    expect(decidePermission(request, deny, { caseInsensitive: true }).decision).toBe('deny')
  })
})

describe('强制拦截', () => {
  const askGuard: PermissionGuard = (r) =>
    r.targets.command?.includes('format')
      ? { effect: 'ask', reasonCode: 'permission.dangerous_command' }
      : undefined
  const denyGuard: PermissionGuard = (r) =>
    r.targets.paths?.includes('id_rsa')
      ? { effect: 'deny', reasonCode: 'permission.sensitive_path', reason: 'Private key.' }
      : undefined
  const guards = [askGuard, denyGuard]

  it('不能被 allow 规则覆盖', () => {
    const allowAll = [rule('allow', {})]
    expect(
      decidePermission(req(tools.run, { command: 'format c:' }), allowAll, { guards }),
    ).toEqual({
      decision: 'ask',
      reasonCode: 'permission.dangerous_command',
      matchedRuleIds: [],
    })
    expect(decidePermission(req(tools.read, { paths: ['id_rsa'] }), allowAll, { guards })).toEqual({
      decision: 'deny',
      reasonCode: 'permission.sensitive_path',
      matchedRuleIds: [],
      reason: 'Private key.',
    })
  })

  it('取最严格的拦截；规则更严格时以规则为准', () => {
    const both = req(tools.run, { command: 'format', paths: ['id_rsa'] })
    expect(decidePermission(both, [], { guards })).toMatchObject({
      decision: 'deny',
      reasonCode: 'permission.sensitive_path',
    })
    // 两个拦截顺序相反时结果相同
    expect(decidePermission(both, [], { guards: [denyGuard, askGuard] })).toMatchObject({
      reasonCode: 'permission.sensitive_path',
    })
    const denyRule = rule('deny', { tool: 'run_command' })
    expect(
      decidePermission(req(tools.run, { command: 'format' }), [denyRule], { guards }),
    ).toMatchObject({
      decision: 'deny',
      reasonCode: PermissionReasonCode.DeniedByRule,
      matchedRuleIds: [denyRule.id],
    })
    // 拦截 deny 没有说明时使用通用说明
    const bare: PermissionGuard = () => ({ effect: 'deny', reasonCode: 'x' })
    expect(decidePermission(req(tools.read), [], { guards: [bare] })).toMatchObject({
      reason: expect.any(String) as unknown as string,
    })
  })
})

describe('createPermissionEngine', () => {
  it('每次判定读取当前规则', async () => {
    const rules: PermissionRule[] = []
    const engine = createPermissionEngine({ rules: () => rules, caseInsensitive: true, guards: [] })
    expect((await engine.decide(req(tools.run, { command: 'ls' }))).decision).toBe('ask')
    rules.push(rule('allow', { command: ['LS'] }))
    expect((await engine.decide(req(tools.run, { command: 'ls' }))).decision).toBe('allow')
    const plain = createPermissionEngine({ rules: () => [] })
    expect((await plain.decide(req(tools.read))).decision).toBe('allow')
  })
})

describe('预设', () => {
  it.each([
    ['read-only', 'deny', 'allow'],
    ['ask', 'ask', 'allow'],
    ['auto', 'allow', 'allow'],
  ] as const)('%s', (mode, changing, read) => {
    const rules = presetRules(mode)
    for (const r of rules) expect(PermissionRuleSchema.parse(r)).toEqual(r)
    expect(rules.every((r) => r.source === 'preset' && r.scope === 'global')).toBe(true)
    for (const d of [tools.write, tools.run, tools.fetch]) {
      expect(decidePermission(req(d, { command: 'x' }), rules).decision).toBe(changing)
    }
    expect(decidePermission(req(tools.read), rules).decision).toBe(read)
  })

  it('询问模式没有预设规则，审批生成的 allow 规则可以生效', () => {
    expect(presetRules('ask')).toEqual([])
    const allow = approvalRule({
      id: 'a1',
      scope: 'session',
      definition: tools.run,
      targets: { command: 'npm test' },
    })
    const rules = [...presetRules('ask'), allow]
    expect(decidePermission(req(tools.run, { command: 'npm test' }), rules).decision).toBe('allow')
    expect(decidePermission(req(tools.run, { command: 'npm run x' }), rules).decision).toBe('ask')
    // 只读模式下 allow 规则不能放行
    const readOnly = [...presetRules('read-only'), allow]
    expect(decidePermission(req(tools.run, { command: 'npm test' }), readOnly).decision).toBe(
      'deny',
    )
  })

  it('切换模式替换预设、保留其他规则', () => {
    const user = rule('deny', { path: ['secret/**'] })
    const next = applyPreset([...presetRules('read-only'), user], 'auto')
    expect(next).toEqual([...presetRules('auto'), user])
  })
})

describe('approvalRule', () => {
  it('命令按段记录，之后每段都在其中才放行；* 按字面', () => {
    const r = approvalRule({
      id: 'a1',
      scope: 'session',
      definition: tools.run,
      targets: { command: 'npm  install && ls *.ts' },
    })
    expect(r).toEqual({
      id: 'a1',
      scope: 'session',
      effect: 'allow',
      match: { tool: 'run_command', command: ['npm install', 'ls \\*.ts'] },
      source: 'approval',
    })
    expect(PermissionRuleSchema.parse(r)).toEqual(r)
    expect(
      decidePermission(req(tools.run, { command: 'ls *.ts; npm install' }), [r]).decision,
    ).toBe('allow')
    expect(decidePermission(req(tools.run, { command: 'ls a.ts' }), [r]).decision).toBe('ask')
    expect(decidePermission(req(tools.run, { command: 'npm install && rm x' }), [r]).decision).toBe(
      'ask',
    )
  })

  it('无法可靠拆分的命令记录整条，allow 不匹配', () => {
    const r = approvalRule({
      id: 'a2',
      scope: 'project',
      definition: tools.run,
      targets: { command: 'echo $(id)' },
    })
    expect(r.match.command).toEqual(['echo $(id)'])
    expect(decidePermission(req(tools.run, { command: 'echo $(id)' }), [r]).decision).toBe('ask')
  })

  it('路径按字面记录', () => {
    const r = approvalRule({
      id: 'a3',
      scope: 'project',
      definition: tools.write,
      targets: { paths: ['src/[x]*.ts'] },
    })
    expect(r.match).toEqual({ tool: 'write_file', path: ['src/[[]x[]][*].ts'] })
    expect(decidePermission(req(tools.write, { paths: ['src/[x]*.ts'] }), [r]).decision).toBe(
      'allow',
    )
    expect(decidePermission(req(tools.write, { paths: ['src/xa.ts'] }), [r]).decision).toBe('ask')
    expect(
      approvalRule({ id: 'a4', scope: 'session', definition: tools.write, targets: { paths: [] } })
        .match,
    ).toEqual({ tool: 'write_file' })
  })
})
