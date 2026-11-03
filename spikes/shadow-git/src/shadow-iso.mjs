// 基于 isomorphic-git（纯 JS）的影子仓库检查点，流程与 shadow-cli.mjs 相同。
import fs from 'node:fs'
import path from 'node:path'
import git from 'isomorphic-git'

const BRANCH = 'checkpoints'
const AUTHOR = {
  name: 'NEXUS-OS',
  email: 'checkpoint@nexus.invalid',
  timestamp: 0,
  timezoneOffset: 0,
}

export function createIsoShadow({ gitDir, workTree, maxFileBytes, extraExcludes }) {
  const base = { fs, dir: workTree, gitdir: gitDir }
  let cache = {}
  let head = null
  const large = new Set()

  function isLarge(rel) {
    try {
      const st = fs.lstatSync(path.join(workTree, ...rel.split('/')))
      return st.isFile() && st.size > maxFileBytes
    } catch {
      return false
    }
  }

  async function changedTree(from, to) {
    const out = []
    await git.walk({
      ...base,
      cache,
      trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
      map: async (filepath, [a, b]) => {
        if (filepath === '.') return
        const [ta, tb] = await Promise.all([a?.type(), b?.type()])
        if (ta === 'tree' || tb === 'tree') return
        const [oa, ob] = await Promise.all([a?.oid(), b?.oid()])
        if (!a) out.push({ status: 'A', path: filepath })
        else if (!b) out.push({ status: 'D', path: filepath })
        else if (oa !== ob || (await a.mode()) !== (await b.mode()))
          out.push({ status: 'M', path: filepath })
      },
    })
    return out
  }

  return {
    kind: 'isomorphic-git',
    async init() {
      fs.rmSync(gitDir, { recursive: true, force: true })
      await git.init({ ...base, defaultBranch: BRANCH })
      await git.setConfig({ ...base, path: 'core.autocrlf', value: 'false' })
      fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true })
      fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), extraExcludes.join('\n') + '\n')
    },

    async checkpoint(message) {
      const t0 = performance.now()
      for (const rel of [...large]) if (!isLarge(rel)) large.delete(rel)
      // HEAD 始终指向检查点分支；恢复时不移动 HEAD，只改写索引与工作区。
      const rows = await git.statusMatrix({ ...base, cache })
      const add = []
      const remove = []
      let ignoredByWorkaround = 0
      for (const [rel, headStatus, workdir, stage] of rows) {
        const staged = (workdir === 1 && stage === 1) || (workdir === 2 && stage === 2)
        if (workdir === 0) {
          if (stage !== 0) remove.push(rel)
        } else if (large.has(rel) || isLarge(rel)) {
          large.add(rel)
          if (stage !== 0) remove.push(rel)
        } else if (!staged) {
          // statusMatrix 判断忽略规则时不传 gitdir，读的是 <工作区>/.git/info/exclude（用户仓库的），
          // 影子仓库的 info/exclude 不生效；未跟踪的文件需按影子仓库再判断一次。
          if (
            headStatus === 0 &&
            stage === 0 &&
            (await git.isIgnored({ ...base, filepath: rel }))
          ) {
            ignoredByWorkaround++
            continue
          }
          add.push(rel)
        }
      }
      const tScan = performance.now()
      if (add.length) await git.add({ ...base, cache, filepath: add, parallel: true })
      for (const rel of remove) await git.remove({ ...base, cache, filepath: rel })
      const tAdd = performance.now()
      let created = false
      if (add.length || remove.length || !head) {
        head = await git.commit({
          ...base,
          cache,
          ref: `refs/heads/${BRANCH}`,
          message,
          author: AUTHOR,
          ...(head ? { parent: [head] } : { parent: [] }),
        })
        created = true
      }
      const t1 = performance.now()
      return {
        commit: head,
        created,
        large: [...large],
        ignoredByWorkaround,
        processes: 0,
        ms: { scan: tScan - t0, add: tAdd - tScan, commit: t1 - tAdd, total: t1 - t0 },
      }
    },

    diff: changedTree,

    async restore(commit) {
      const t0 = performance.now()
      const pre = await this.checkpoint(`before restore to ${commit}`)
      const tCp = performance.now()
      const changes = await changedTree(pre.commit, commit)
      const tDiff = performance.now()
      await git.checkout({ ...base, cache, ref: commit, force: true, noUpdateHead: true })
      const t1 = performance.now()
      return {
        before: pre.commit,
        changes,
        ms: { checkpoint: tCp - t0, diff: tDiff - tCp, apply: t1 - tDiff, total: t1 - t0 },
      }
    },

    async entries(commit) {
      const out = []
      await git.walk({
        ...base,
        cache,
        trees: [git.TREE({ ref: commit })],
        map: async (filepath, [e]) => {
          if (filepath === '.') return
          const type = await e.type()
          if (type === 'tree') return
          out.push({ mode: (await e.mode()).toString(8).padStart(6, '0'), path: filepath })
        },
      })
      return out
    },

    async gc() {
      cache = {}
      return null
    },
  }
}
