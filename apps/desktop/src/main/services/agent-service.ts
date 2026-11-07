/**
 * Agent 定义（M3-11，Runtime §3，ADR-0016）。
 *
 * - 内置 `builtin.coder` 由代码提供，只读；用户与导入的 Agent 存在 `agents` / `agent_versions` 表。
 * - 草稿与已发布版本分开：编辑只改草稿，发布时版本号加一；会话引用的始终是具体版本。
 * - 校验需要工具、MCP、Skills 与模型清单，由调用方注入（这里不读文件、不连 MCP）。
 * - 运行相关：主进程从这里取指令、最终工具 / Skills、权限预设与固定模型，写入 `host.init`。
 */
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  BUILTIN_CODER,
  BUILTIN_CODER_ID,
  BUILTIN_TOOL_CATALOG,
  buildSystemPrompt,
  estimateTokens,
  operatingSystemName,
  presetRules,
  selectSkills,
  skillSelected,
  toolSelected,
  validateAgentDefinition,
  type AgentValidationContext,
} from '@cairn/core'
import {
  AgentDefinition,
  AgentDraft,
  AgentDraftFields,
  AgentDraftInput,
  RpcError,
  type AgentDefinitionRef,
  type AgentDetail,
  type AgentDiff,
  type AgentDiffEndpoint,
  type AgentEffectiveConfig,
  type AgentSource,
  type AgentSummary,
  type AgentVersionSummary,
  type AgentValidationResult,
  type LocalizedText,
  type McpToolExposure,
  type ModelRef,
  type PermissionRule,
  type SkillCatalogEntry,
  type SkillSummary,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { SessionEventService } from './event-service.js'

export const AgentServiceErrorCode = {
  NotFound: 'agent.not_found',
  Readonly: 'agent.readonly',
  Invalid: 'agent.invalid',
  InUse: 'agent.in_use',
  NoDraft: 'agent.no_draft',
} as const

export interface AgentServiceOptions {
  readonly storage: Pick<Storage, 'agents' | 'sessions' | 'mcpServers'>
  readonly events: Pick<SessionEventService, 'readAfter'>
  /** 已安装 / 内置（含项目内）技能的摘要；校验与生效配置用。 */
  readonly skills: {
    list(input: { projectId?: string }): { skills: SkillSummary[] }
    catalog(sessionId: string): SkillCatalogEntry[]
  }
  /** 当前可用的 MCP 工具。 */
  readonly mcp: { exposures(): McpToolExposure[] }
  readonly models: { has(model: ModelRef): boolean }
  readonly now?: () => number
  readonly createId?: () => string
}

/** 界面可调用的 Agent 命令（M3-11）。 */
export interface AgentCommands {
  list(input: {
    includeArchived?: boolean | undefined
    source?: AgentSource | undefined
    status?: 'draft' | 'published' | undefined
    query?: string | undefined
  }): { agents: AgentSummary[] }
  get(input: { agentId: string; version?: number | undefined }): AgentDetail
  saveDraft(input: { definition: AgentDraftInput }): AgentDetail
  publish(input: { agentId: string }): AgentDetail
  duplicate(input: { agentId: string; name?: LocalizedText | undefined }): AgentDetail
  archive(input: { agentId: string }): AgentDetail
  unarchive(input: { agentId: string }): AgentDetail
  delete(input: { agentId: string }): Record<string, never>
  versions(input: { agentId: string }): { versions: AgentVersionSummary[] }
  diff(input: { agentId: string; from: AgentDiffEndpoint; to: AgentDiffEndpoint }): AgentDiff
  export(input: { agentId: string; version?: number | undefined }): { markdown: string }
  import(input: { markdown: string }): AgentDetail
  effectiveConfig(input: { agentId: string; sessionId?: string | undefined }): AgentEffectiveConfig
}

export interface AgentService extends AgentCommands {
  /** 运行引用：只返回已发布版本。 */
  definition(ref: AgentDefinitionRef): AgentDefinition | undefined
  /** 按 Agent 的选择过滤这一轮的技能。 */
  skillsFor(ref: AgentDefinitionRef, sessionId: string): SkillCatalogEntry[]
  /** 按 Agent 的选择过滤这一轮的 MCP 工具。 */
  mcpToolsFor(ref: AgentDefinitionRef): McpToolExposure[]
  /** Agent 的权限预设叠加应用已有的规则（引擎取最严格的）。 */
  permissionRulesFor(ref: AgentDefinitionRef, rules: readonly PermissionRule[]): PermissionRule[]
}

const option = (value: string | undefined): string | undefined => {
  const text = value?.trim()
  return text ? text : undefined
}

const generatedId = (name: LocalizedText, prefix: 'user' | 'imported', random: () => string) => {
  const slug = (name['en-US'] ?? name['zh-CN'] ?? 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${prefix}.${slug || 'agent'}-${random()}`
}

export function createAgentService(options: AgentServiceOptions): AgentService {
  const { storage, events } = options
  const now = options.now ?? Date.now
  const createId = options.createId ?? (() => randomBytes(3).toString('hex'))

  function projectIdOf(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return storage.sessions.get(sessionId)?.projectId
  }

  /** 校验上下文：内置工具、已配置的 MCP 服务、当前连接的工具与已安装技能。 */
  function validationContext(): AgentValidationContext {
    const skills = options.skills.list({}).skills
    return {
      knownTools: BUILTIN_TOOL_CATALOG.map((tool) => tool.name),
      mcpServers: storage.mcpServers.list().map((server) => server.serverId),
      mcpTools: options.mcp.exposures().map((tool) => tool.name),
      skillNames: skills.map((skill) => skill.name),
      hasModel: (model) => options.models.has(model),
    }
  }

  function validate(fields: AgentDraftFields): AgentValidationResult {
    return validateAgentDefinition(fields, validationContext())
  }

  function recordOf(agentId: string) {
    const record = storage.agents.get(agentId)
    if (!record) throw new RpcError(AgentServiceErrorCode.NotFound, { agentId })
    return record
  }

  function publishedOf(agentId: string, version?: number): AgentDefinition | undefined {
    if (agentId === BUILTIN_CODER_ID) {
      return version === undefined || version === BUILTIN_CODER.version ? BUILTIN_CODER : undefined
    }
    const record = storage.agents.get(agentId)
    if (!record) return undefined
    const versions = storage.agents.versions(agentId)
    const wanted =
      version === undefined ? versions.at(-1) : versions.find((item) => item.version === version)
    if (!wanted) return undefined
    return AgentDefinition.parse(wanted.definition)
  }

  function draftOf(agentId: string): AgentDraft | undefined {
    if (agentId === BUILTIN_CODER_ID) return undefined
    const record = storage.agents.get(agentId)
    if (!record || record.draft === undefined) return undefined
    return AgentDraft.parse(record.draft)
  }

  function detailOf(agentId: string, version?: number): AgentDetail {
    if (agentId === BUILTIN_CODER_ID) {
      if (version !== undefined && version !== BUILTIN_CODER.version) {
        throw new RpcError(AgentServiceErrorCode.NotFound, { agentId, version })
      }
      return {
        agentId,
        source: 'builtin',
        archived: false,
        published: BUILTIN_CODER,
        validation: validate(BUILTIN_CODER),
      }
    }
    const record = recordOf(agentId)
    const draft = draftOf(agentId)
    const published = publishedOf(agentId, version)
    if (version !== undefined && !published) {
      throw new RpcError(AgentServiceErrorCode.NotFound, { agentId, version })
    }
    const fields = draft ?? published
    if (!fields) throw new RpcError(AgentServiceErrorCode.NotFound, { agentId })
    return {
      agentId,
      source: record!.source,
      archived: record!.archived,
      ...(draft ? { draft } : {}),
      ...(published ? { published } : {}),
      validation: validate(fields),
    }
  }

  function saveFields(
    fields: AgentDraftFields,
    source: AgentSource,
    requestedId: string | undefined,
  ): string {
    const agentId =
      requestedId ?? generatedId(fields.name, source === 'imported' ? 'imported' : 'user', createId)
    if (agentId === BUILTIN_CODER_ID) throw new RpcError(AgentServiceErrorCode.Readonly)
    if (!storage.agents.get(agentId)) {
      storage.agents.create({ agentId, source, draft: { id: agentId, ...fields } })
    } else {
      storage.agents.saveDraft(agentId, { id: agentId, ...fields })
    }
    return agentId
  }

  function summaryOf(agentId: string): AgentSummary {
    if (agentId === BUILTIN_CODER_ID) {
      return {
        agentId,
        name: BUILTIN_CODER.name,
        description: BUILTIN_CODER.description,
        icon: BUILTIN_CODER.icon,
        color: BUILTIN_CODER.color,
        source: 'builtin',
        archived: false,
        status: 'published',
        version: BUILTIN_CODER.version,
        hasDraft: false,
        updatedAt: 0,
      }
    }
    const record = recordOf(agentId)
    const draft = draftOf(agentId)
    const published = publishedOf(agentId)
    const fields = draft ?? published
    if (!fields) throw new RpcError(AgentServiceErrorCode.NotFound, { agentId })
    return {
      agentId,
      name: fields.name,
      description: fields.description,
      ...(fields.icon ? { icon: fields.icon } : {}),
      ...(fields.color ? { color: fields.color } : {}),
      source: record.source,
      archived: record.archived,
      status: published ? 'published' : 'draft',
      version: published?.version ?? 0,
      hasDraft: draft !== undefined,
      updatedAt: record.updatedAt,
    }
  }

  /** 引用某个 Agent 的会话数与具体版本的会话数。 */
  function usageOf(agentId: string): Map<number, number> {
    const usage = new Map<number, number>()
    for (const session of storage.sessions.list({ includeArchived: true })) {
      const seen = new Set<number>()
      for (const event of events.readAfter(session.sessionId, 0)) {
        if (event.type !== 'run.created' || event.payload.agent.id !== agentId) continue
        const version = event.payload.agent.version
        if (seen.has(version)) continue
        seen.add(version)
        usage.set(version, (usage.get(version) ?? 0) + 1)
      }
    }
    return usage
  }

  /**
   * 运行用的定义：找不到（旧会话引用了已不存在的版本，或应用升级前的 `default`）时返回 undefined，
   * 调用方按“不过滤”处理，不能因此让宿主启动失败。
   */
  function runDefinition(ref: AgentDefinitionRef): AgentDefinition | undefined {
    const definition = publishedOf(ref.id, ref.version)
    return definition && definition.status === 'published' ? definition : undefined
  }

  function fieldsOfEndpoint(agentId: string, endpoint: AgentDiffEndpoint): AgentDraftFields {
    if (endpoint === 'draft') {
      const fields = effectiveFields(agentId)
      return fields.fields
    }
    const definition = publishedOf(agentId, endpoint)
    if (!definition)
      throw new RpcError(AgentServiceErrorCode.NotFound, { agentId, version: endpoint })
    return definition
  }

  const DIFF_FIELDS = [
    'name',
    'description',
    'icon',
    'color',
    'model',
    'tools',
    'skills',
    'permissions',
    'limits',
    'context',
    'memory',
    'tags',
    'inputSchema',
    'outputSchema',
  ] as const

  /** 只保留草稿字段：已发布的完整定义带版本与时间戳，写入草稿前要丢掉。 */
  function pickDraftFields(source: AgentDraftFields): AgentDraftFields {
    const picked: Record<string, unknown> = { instructions: source.instructions }
    for (const key of DIFF_FIELDS) {
      const value = source[key]
      if (value !== undefined) picked[key] = value
    }
    return picked as AgentDraftFields
  }

  function exportFields(agentId: string, version?: number): AgentDraftFields {
    if (version !== undefined) {
      const definition = publishedOf(agentId, version)
      if (!definition) throw new RpcError(AgentServiceErrorCode.NotFound, { agentId, version })
      return definition
    }
    const fields = draftOf(agentId) ?? publishedOf(agentId)
    if (!fields) throw new RpcError(AgentServiceErrorCode.NotFound, { agentId })
    return fields
  }

  function effectiveFields(agentId: string): {
    fields: AgentDraftFields
    source: 'draft' | 'published'
    version: number
  } {
    const draft = draftOf(agentId)
    if (draft)
      return { fields: draft, source: 'draft', version: publishedOf(agentId)?.version ?? 0 }
    const published = publishedOf(agentId)
    if (published) return { fields: published, source: 'published', version: published.version }
    throw new RpcError(AgentServiceErrorCode.NotFound, { agentId })
  }

  return {
    list(input) {
      const all = [BUILTIN_CODER_ID, ...storage.agents.list().map((record) => record.agentId)]
      const query = input.query?.trim().toLowerCase()
      const agents = all
        .map(summaryOf)
        .filter((agent) => (input.includeArchived ? true : !agent.archived))
        .filter((agent) => (input.source === undefined ? true : agent.source === input.source))
        .filter((agent) => (input.status === undefined ? true : agent.status === input.status))
        .filter((agent) => {
          if (!query) return true
          const haystack = [
            agent.name['zh-CN'],
            agent.name['en-US'],
            agent.description['zh-CN'],
            agent.description['en-US'],
          ]
            .filter((value): value is string => value !== undefined)
            .join('\n')
            .toLowerCase()
          return haystack.includes(query)
        })
      return { agents }
    },

    get({ agentId, version }) {
      return detailOf(agentId, version)
    },

    saveDraft({ definition }) {
      const parsed = AgentDraftInput.safeParse(definition)
      if (!parsed.success) {
        const first = parsed.error.issues[0]!
        throw new RpcError(AgentServiceErrorCode.Invalid, {
          path: first.path.join('.') || 'definition',
          code: 'schema',
        })
      }
      const { id, ...fields } = parsed.data
      const agentId = saveFields(fields, 'user', option(id))
      return detailOf(agentId)
    },

    publish({ agentId }) {
      if (agentId === BUILTIN_CODER_ID) throw new RpcError(AgentServiceErrorCode.Readonly)
      const record = recordOf(agentId)!
      const draft = draftOf(agentId)
      if (!draft) throw new RpcError(AgentServiceErrorCode.NoDraft, { agentId })
      const validation = validate(draft)
      if (!validation.ok) {
        const first = validation.errors[0]!
        throw new RpcError(AgentServiceErrorCode.Invalid, {
          path: first.path,
          code: first.code,
        })
      }
      const { id: _id, ...fields } = draft
      const version = (storage.agents.versions(agentId).at(-1)?.version ?? 0) + 1
      const at = now()
      storage.agents.addVersion({
        agentId,
        version,
        definition: {
          id: agentId,
          version,
          source: record.source,
          status: 'published',
          ...fields,
          createdAt: record.createdAt,
          updatedAt: at,
          schemaVersion: 1,
        },
      })
      storage.agents.clearDraft(agentId)
      return detailOf(agentId)
    },

    duplicate({ agentId, name }) {
      const fields = pickDraftFields(exportFields(agentId))
      const duplicateName: LocalizedText = name ?? {
        'zh-CN': `${fields.name['zh-CN'] ?? fields.name['en-US'] ?? 'Agent'} 副本`,
        'en-US': `${fields.name['en-US'] ?? fields.name['zh-CN'] ?? 'Agent'} copy`,
      }
      const created = saveFields({ ...fields, name: duplicateName }, 'user', undefined)
      return detailOf(created)
    },

    archive({ agentId }) {
      if (agentId === BUILTIN_CODER_ID) throw new RpcError(AgentServiceErrorCode.Readonly)
      recordOf(agentId)
      storage.agents.setArchived(agentId, true)
      return detailOf(agentId)
    },

    unarchive({ agentId }) {
      if (agentId === BUILTIN_CODER_ID) throw new RpcError(AgentServiceErrorCode.Readonly)
      recordOf(agentId)
      storage.agents.setArchived(agentId, false)
      return detailOf(agentId)
    },

    delete({ agentId }) {
      if (agentId === BUILTIN_CODER_ID) throw new RpcError(AgentServiceErrorCode.Readonly)
      recordOf(agentId)
      if (usageOf(agentId).size > 0) throw new RpcError(AgentServiceErrorCode.InUse, { agentId })
      storage.agents.remove(agentId)
      return {}
    },

    versions({ agentId }) {
      if (agentId === BUILTIN_CODER_ID) {
        return {
          versions: [
            {
              version: 1,
              publishedAt: 0,
              name: BUILTIN_CODER.name,
              description: BUILTIN_CODER.description,
              instructionsBytes: Buffer.byteLength(BUILTIN_CODER.instructions, 'utf8'),
              usedBySessions: usageOf(agentId).get(1) ?? 0,
            },
          ],
        }
      }
      const usage = usageOf(agentId)
      recordOf(agentId)
      return {
        versions: storage.agents.versions(agentId).map((record) => {
          const definition = AgentDefinition.parse(record.definition)
          return {
            version: record.version,
            publishedAt: record.publishedAt,
            name: definition.name,
            description: definition.description,
            instructionsBytes: Buffer.byteLength(definition.instructions, 'utf8'),
            usedBySessions: usage.get(record.version) ?? 0,
          }
        }),
      }
    },

    diff({ agentId, from, to }) {
      const before = fieldsOfEndpoint(agentId, from)
      const after = fieldsOfEndpoint(agentId, to)
      const fields = DIFF_FIELDS.filter((key) => !isDeepStrictEqual(before[key], after[key])).map(
        (key) => ({ path: key, from: before[key], to: after[key] }),
      )
      return {
        fields,
        instructions: { from: before.instructions, to: after.instructions },
      }
    },

    export({ agentId, version }) {
      const fields = exportFields(agentId, version)
      const header = {
        name: fields.name,
        description: fields.description,
        ...(fields.icon ? { icon: fields.icon } : {}),
        ...(fields.color ? { color: fields.color } : {}),
        model: fields.model,
        tools: fields.tools,
        skills: fields.skills,
        permissions: fields.permissions,
        limits: fields.limits,
        context: fields.context,
        memory: fields.memory,
        ...(fields.tags ? { tags: fields.tags } : {}),
        ...(fields.inputSchema ? { inputSchema: fields.inputSchema } : {}),
        ...(fields.outputSchema ? { outputSchema: fields.outputSchema } : {}),
      }
      return {
        markdown: `---\n${stringifyYaml(header).trimEnd()}\n---\n\n${fields.instructions.trim()}\n`,
      }
    },

    import({ markdown }) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown)
      if (!match) {
        throw new RpcError(AgentServiceErrorCode.Invalid, {
          path: 'markdown',
          code: 'front_matter',
        })
      }
      let header: unknown
      try {
        header = parseYaml(match[1] as string)
      } catch {
        throw new RpcError(AgentServiceErrorCode.Invalid, { path: 'markdown', code: 'yaml' })
      }
      if (typeof header !== 'object' || header === null) {
        throw new RpcError(AgentServiceErrorCode.Invalid, { path: 'markdown', code: 'yaml' })
      }
      const parsed = AgentDraftFields.safeParse({
        ...(header as Record<string, unknown>),
        instructions: match[2] as string,
      })
      if (!parsed.success) {
        const first = parsed.error.issues[0]!
        throw new RpcError(AgentServiceErrorCode.Invalid, {
          path: first.path.join('.'),
          code: 'schema',
        })
      }
      const validation = validate(parsed.data)
      if (!validation.ok) {
        const first = validation.errors[0]!
        throw new RpcError(AgentServiceErrorCode.Invalid, {
          path: first.path,
          code: first.code,
        })
      }
      const agentId = saveFields(parsed.data, 'imported', undefined)
      return detailOf(agentId)
    },

    effectiveConfig({ agentId, sessionId }) {
      const { fields, source, version } = effectiveFields(agentId)
      const session = sessionId === undefined ? undefined : storage.sessions.get(sessionId)
      const workspacePath = session?.workspacePath ?? ''
      const projectId = projectIdOf(sessionId)
      const skills = options.skills
        .list(projectId === undefined ? {} : { projectId })
        .skills.filter((skill) => skill.enabled && !skill.shadowed)
      const tools = [
        ...BUILTIN_TOOL_CATALOG.map((tool) => ({
          ...tool,
          source: { kind: 'builtin' as const },
        })),
        ...options.mcp.exposures().map((tool) => ({
          name: tool.name,
          description: tool.description,
          category: tool.category,
          source: { kind: 'mcp' as const, serverId: tool.serverId },
        })),
      ].filter((tool) => toolSelected(fields.tools, tool))
      const selectedSkills = skills
        .filter((skill) => skillSelected(fields.skills, skill))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          pinned: skill.pinned || fields.skills.pinned?.includes(skill.name) === true,
          tokens: skill.tokens,
        }))
      const systemPrompt = buildSystemPrompt({
        tools: tools.length > 0,
        environment: {
          os: operatingSystemName(process.platform),
          workspacePath,
          date: new Date(now()).toISOString().slice(0, 10),
        },
        ...(fields.instructions.trim() ? { agentInstructions: fields.instructions } : {}),
        ...(selectedSkills.length > 0
          ? {
              skills: selectedSkills.map((skill) => ({
                name: skill.name,
                description: skill.description,
              })),
            }
          : {}),
      })
      return {
        agentId,
        source,
        version,
        systemPrompt,
        tools,
        skills: selectedSkills,
        permissionRules: presetRules(fields.permissions),
        budget: {
          contextWindow: 128_000,
          reserveOutputTokens: fields.context.reserveOutputTokens ?? 4_096,
          systemPromptTokens: estimateTokens(systemPrompt),
          toolsTokens: estimateTokens(
            tools.map((tool) => `${tool.name}: ${tool.description}`).join('\n'),
          ),
          skillsTokens: estimateTokens(
            selectedSkills.map((skill) => `${skill.name}: ${skill.description}`).join('\n'),
          ),
          historyTokens: 0,
        },
      }
    },

    definition: runDefinition,

    skillsFor(ref, sessionId) {
      const catalog = options.skills.catalog(sessionId)
      const definition = runDefinition(ref)
      return definition ? selectSkills(definition.skills, catalog) : catalog
    },

    mcpToolsFor(ref) {
      const exposures = options.mcp.exposures()
      const definition = runDefinition(ref)
      if (!definition) return exposures
      return exposures.filter((tool) =>
        toolSelected(definition.tools, {
          name: tool.name,
          category: tool.category,
          source: { kind: 'mcp', serverId: tool.serverId },
        }),
      )
    },

    permissionRulesFor(ref, rules) {
      const definition = runDefinition(ref)
      if (!definition) return [...rules]
      return [...presetRules(definition.permissions), ...rules]
    },
  }
}
