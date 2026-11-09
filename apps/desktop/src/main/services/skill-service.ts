/**
 * 技能（M3-07，Runtime §21.2，ADR-0017）。
 *
 * - 内置：随应用放在 `builtinDir`，每个子目录一份。
 * - 用户安装：`userDir`，由 `skill.install` 从文件夹或 zip 写入。
 * - 项目内：`.agents/skills/` 与 `.cairn/skills/`，项目设置开启后才扫描。同名时项目内优先于已安装，
 *   已安装优先于内置；`.cairn/skills` 优先于 `.agents/skills`。停用的技能不再挡住低优先级的同名技能。
 * - 启用和“始终加载”记在存储里。没有记录时为启用、不固定。
 *
 * 不依赖 Electron。安装只写用户目录，不改项目文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { estimateTokens } from '@cairn/core'
import {
  installSkill,
  previewSkill,
  scanSkillRoot,
  SkillError,
  SKILL_NAME_PATTERN,
  SKILL_PIN_MAX_CHARS,
  type SkillPackage,
} from '@cairn/skills'
import {
  RpcError,
  type SkillCatalogEntry,
  type SkillDetail,
  type SkillFileInfo,
  type SkillInstallSource,
  type SkillSource,
  type SkillSummary,
} from '@cairn/protocol'
import type { SkillPref, Storage } from '@cairn/storage'

/** 安装时让用户选择的来源种类（M3-08）。 */
export type SkillPickKind = SkillInstallSource['kind']

export const SkillServiceErrorCode = {
  Invalid: 'skills.invalid',
  Duplicate: 'skills.duplicate',
  Traversal: 'skills.traversal',
  TooLarge: 'skills.too_large',
  NotFound: 'skills.not_found',
  /** 内置和项目内技能不能从这里卸载。 */
  NotUninstallable: 'skills.not_uninstallable',
} as const

const PROJECT_ROOTS = [
  { dir: path.join('.agents', 'skills'), priority: 3 },
  { dir: path.join('.cairn', 'skills'), priority: 4 },
] as const

export interface SkillServiceOptions {
  readonly storage: Pick<Storage, 'projects' | 'sessions' | 'skillPrefs'>
  /** 内置技能根目录。不存在时当作没有内置技能。 */
  readonly builtinDir: string
  /** 用户安装的技能目录（应用数据目录下的 `skills/`）。 */
  readonly userDir: string
  /** 让用户选择技能来源（M3-08）；取消时返回 undefined。没提供时 `pickSource` 视为取消。 */
  readonly pickSource?: (kind: SkillPickKind) => Promise<string | undefined>
}

export interface SkillCommands {
  list(input: { projectId?: string | undefined }): { skills: SkillSummary[] }
  get(input: { name: string; source: SkillSource; projectId?: string | undefined }): SkillDetail
  /** 用系统对话框选择文件夹或 zip（M3-08）。取消时结果不含 `source`。 */
  pickSource(input: { kind: SkillPickKind }): Promise<{ source?: SkillInstallSource }>
  install(input: { source: SkillInstallSource; confirm?: boolean | undefined }): {
    installed: boolean
    skill: SkillDetail
  }
  /** 从市场下载 zip 后走同一条安装路径（M5）。只接受 ClawHub 的 https 地址。 */
  installFromUrl(input: { url: string }): Promise<{ installed: boolean; skill: SkillDetail }>
  uninstall(input: { name: string }): Record<string, never>
  setEnabled(input: {
    name: string
    source: SkillSource
    projectId?: string | undefined
    enabled?: boolean | undefined
    pinned?: boolean | undefined
  }): SkillSummary
}

interface Located {
  readonly source: SkillSource
  readonly projectId?: string
  readonly directory: string
  readonly skill: SkillPackage
  readonly priority: number
  readonly enabled: boolean
  readonly pinned: boolean
  readonly shadowed: boolean
}

function rethrow(error: unknown): never {
  if (error instanceof SkillError) throw new RpcError(error.code)
  throw error
}

function filesOf(skill: SkillPackage): SkillFileInfo[] {
  return skill.files.map((file) => ({ path: file.path, bytes: file.bytes, script: file.script }))
}

/**
 * 每轮的 token 估算（M3-08），尽量贴近 `system-prompt.ts` 实际注入的内容：索引是一行
 * `- name: description`；固定加载时再加一段正文（超过 32 KB 的部分宿主会截断）。
 */
function tokensOf(skill: SkillPackage): { index: number; pinned: number } {
  const index = estimateTokens(`- ${skill.name}: ${skill.description}`)
  const body = skill.body.trim()
  const chars = [...body]
  const kept =
    chars.length > SKILL_PIN_MAX_CHARS ? chars.slice(0, SKILL_PIN_MAX_CHARS).join('') : body
  return {
    index,
    pinned: kept === '' ? index : index + estimateTokens(`## ${skill.name}\n${kept}`),
  }
}

/** 工作区内用相对路径，否则用绝对路径，供 `read_file` 使用。 */
export function skillReadPath(workspace: string, skillDir: string, relative: string): string {
  const absolute = path.resolve(skillDir, ...relative.split('/'))
  const fromWorkspace = path.relative(workspace, absolute)
  const outside =
    fromWorkspace === '..' ||
    fromWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromWorkspace)
  if (fromWorkspace !== '' && !outside) return fromWorkspace.split(path.sep).join('/')
  return absolute
}

function summarize(item: Located): SkillSummary {
  return {
    name: item.skill.name,
    description: item.skill.description,
    sha256: item.skill.sha256,
    source: item.source,
    ...(item.projectId !== undefined ? { projectId: item.projectId } : {}),
    enabled: item.enabled,
    pinned: item.pinned,
    tokens: tokensOf(item.skill),
    shadowed: item.shadowed,
    hasScripts: item.skill.hasScripts,
    ...(item.skill.filesTruncated ? { filesTruncated: true as const } : {}),
    files: filesOf(item.skill),
  }
}

function detailFrom(item: Located): SkillDetail {
  return { ...summarize(item), markdown: item.skill.markdown, body: item.skill.body }
}

function installedDetail(skill: SkillPackage): SkillDetail {
  return {
    name: skill.name,
    description: skill.description,
    sha256: skill.sha256,
    source: 'user',
    enabled: true,
    pinned: false,
    tokens: tokensOf(skill),
    shadowed: false,
    hasScripts: skill.hasScripts,
    ...(skill.filesTruncated ? { filesTruncated: true as const } : {}),
    files: filesOf(skill),
    markdown: skill.markdown,
    body: skill.body,
  }
}

export function createSkillService(options: SkillServiceOptions): SkillCommands & {
  /** 这一轮交给模型的技能。会话不存在时为空。 */
  catalog(sessionId: string): SkillCatalogEntry[]
} {
  const { storage } = options

  const scopeOf = (source: SkillSource, projectId: string | undefined) =>
    source === 'project' ? (projectId ?? '') : 'global'

  const discover = (projectId: string | undefined): Located[] => {
    const raw: Omit<Located, 'enabled' | 'pinned' | 'shadowed'>[] = []
    const pushRoot = (
      root: string,
      source: SkillSource,
      priority: number,
      owner: string | undefined,
    ) => {
      for (const found of scanSkillRoot(root).skills) {
        raw.push({
          source,
          ...(owner !== undefined ? { projectId: owner } : {}),
          directory: found.directory,
          skill: found.skill,
          priority,
        })
      }
    }
    pushRoot(options.builtinDir, 'builtin', 1, undefined)
    pushRoot(options.userDir, 'user', 2, undefined)
    if (projectId !== undefined) {
      const project = storage.projects.get(projectId)
      if (!project) throw new RpcError('project.not_found', { projectId })
      if (project.enableProjectSkills) {
        for (const root of PROJECT_ROOTS) {
          pushRoot(path.join(project.path, root.dir), 'project', root.priority, projectId)
        }
      }
    }
    const annotated = raw.map((item) => {
      const pref = storage.skillPrefs.get(
        scopeOf(item.source, item.projectId),
        item.source,
        item.skill.name,
      )
      return {
        ...item,
        enabled: pref?.enabled ?? true,
        pinned: pref?.pinned ?? false,
      }
    })
    const winner = new Map<string, (typeof annotated)[number]>()
    for (const item of annotated) {
      if (!item.enabled) continue
      const current = winner.get(item.skill.name)
      if (!current || item.priority > current.priority) winner.set(item.skill.name, item)
    }
    return annotated.map((item) => ({
      ...item,
      shadowed: item.enabled && winner.get(item.skill.name) !== item,
    }))
  }

  const find = (projectId: string | undefined, name: string, source: SkillSource): Located => {
    const found = discover(projectId).find(
      (item) => item.skill.name === name && item.source === source,
    )
    if (!found || (source === 'project' && found.projectId !== projectId)) {
      throw new RpcError(SkillServiceErrorCode.NotFound, { name })
    }
    return found
  }

  return {
    list({ projectId }) {
      return { skills: discover(projectId).map(summarize) }
    },

    get(input) {
      return detailFrom(find(input.projectId, input.name, input.source))
    },

    async pickSource({ kind }) {
      const picked = await options.pickSource?.(kind)
      if (picked === undefined) return {}
      const source: SkillInstallSource =
        kind === 'directory' ? { kind: 'directory', path: picked } : { kind: 'zip', path: picked }
      return { source }
    },

    install(input) {
      let skill: SkillPackage
      try {
        skill =
          input.confirm === true
            ? installSkill(input.source, options.userDir)
            : previewSkill(input.source)
      } catch (error) {
        rethrow(error)
      }
      if (input.confirm !== true && fs.existsSync(path.join(options.userDir, skill.name))) {
        throw new RpcError(SkillServiceErrorCode.Duplicate, { name: skill.name })
      }
      return { installed: input.confirm === true, skill: installedDetail(skill) }
    },

    async installFromUrl({ url }) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'clawhub.ai') {
        throw new RpcError(SkillServiceErrorCode.Invalid, { url })
      }
      const response = await fetch(parsed, {
        headers: { Accept: 'application/zip, application/octet-stream' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        throw new RpcError(SkillServiceErrorCode.Invalid, { status: response.status })
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > 25 * 1024 * 1024) {
        throw new RpcError(SkillServiceErrorCode.TooLarge)
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-skill-'))
      const zip = path.join(dir, 'skill.zip')
      try {
        fs.writeFileSync(zip, bytes)
        let skill: SkillPackage
        try {
          skill = installSkill({ kind: 'zip', path: zip }, options.userDir)
        } catch (error) {
          rethrow(error)
        }
        return { installed: true, skill: installedDetail(skill) }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },

    uninstall({ name }) {
      if (!SKILL_NAME_PATTERN.test(name)) {
        throw new RpcError(SkillServiceErrorCode.NotFound, { name })
      }
      const dest = path.resolve(options.userDir, name)
      let stat: fs.Stats | undefined
      try {
        stat = fs.lstatSync(dest)
      } catch {
        stat = undefined
      }
      if (
        stat?.isDirectory() &&
        !stat.isSymbolicLink() &&
        fs.existsSync(path.join(dest, 'SKILL.md'))
      ) {
        fs.rmSync(dest, { recursive: true })
        storage.skillPrefs.delete('global', 'user', name)
        return {}
      }
      const named = (root: string) =>
        scanSkillRoot(root).skills.some((found) => found.skill.name === name)
      if (
        named(options.builtinDir) ||
        storage.projects
          .list()
          .some((project) => PROJECT_ROOTS.some((root) => named(path.join(project.path, root.dir))))
      ) {
        throw new RpcError(SkillServiceErrorCode.NotUninstallable, { name })
      }
      throw new RpcError(SkillServiceErrorCode.NotFound, { name })
    },

    setEnabled(input) {
      const found = find(input.projectId, input.name, input.source)
      const pref: SkillPref = {
        scope: scopeOf(found.source, found.projectId),
        source: found.source,
        name: found.skill.name,
        enabled: input.enabled ?? found.enabled,
        pinned: input.pinned ?? found.pinned,
      }
      storage.skillPrefs.set(pref)
      return summarize({ ...found, enabled: pref.enabled, pinned: pref.pinned })
    },

    catalog(sessionId) {
      const session = storage.sessions.get(sessionId)
      if (!session) return []
      const project = storage.projects.get(session.projectId)
      const workspace = project?.path ?? session.workspacePath
      return discover(session.projectId)
        .filter((item) => item.enabled && !item.shadowed)
        .map((item) => ({
          name: item.skill.name,
          description: item.skill.description,
          sha256: item.skill.sha256,
          source: item.source,
          pinned: item.pinned,
          root: item.directory,
          body: item.skill.body,
          hasScripts: item.skill.hasScripts,
          ...(item.skill.filesTruncated ? { filesTruncated: true as const } : {}),
          files: item.skill.files.map((file) => ({
            path: file.path,
            bytes: file.bytes,
            script: file.script,
            readPath: skillReadPath(workspace, item.directory, file.path),
          })),
        }))
    },
  }
}
