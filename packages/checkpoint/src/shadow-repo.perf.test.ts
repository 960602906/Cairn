/**
 * 性能验收（M1-12，S5）：约 1 万个文件的工作区上，日常检查点 < 2 s、恢复 < 5 s。
 * 只在 CI 中运行（`CI` 环境变量），Windows 是首发平台。首次检查点每个项目只发生一次，不设上限。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openShadowRepo } from './shadow-repo.js'

const FILES = 10_000

/** 固定种子的伪随机数（与 S5 的 fixture 规模相近：约 1000 个目录，0.5～4 KB 的文本为主）。 */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    return state / 2 ** 31
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-checkpoint-perf-'))
const work = path.join(tmp, 'work')

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const timed = async <T>(task: () => Promise<T>) => {
  const start = performance.now()
  const result = await task()
  return { result, ms: performance.now() - start }
}

describe.runIf(process.env.CI)('checkpoint performance (10k files)', () => {
  it('creates daily checkpoints in < 2 s and restores in < 5 s', { timeout: 300_000 }, async () => {
    const next = random(42)
    const line = 'export const value = computeSomething(input, options) // padding text\n'
    const files: string[] = []
    for (let i = 0; i < FILES; i++) {
      const rel = path.join(`p${i % 20}`, `d${Math.floor(i / 10) % 50}`, `f${i}.ts`)
      const size = next() < 0.7 ? 512 + next() * 3584 : 4096 + next() * 28_672
      fs.mkdirSync(path.join(work, path.dirname(rel)), { recursive: true })
      fs.writeFileSync(path.join(work, rel), line.repeat(Math.ceil(size / line.length)))
      files.push(rel)
    }
    const repo = await openShadowRepo({ gitDir: path.join(tmp, 'shadow.git'), workTree: work })
    const first = await timed(() => repo.checkpoint('first'))
    const unchanged = await timed(() => repo.checkpoint('unchanged'))
    expect(unchanged.result.created).toBe(false)

    // 一轮对话的改动：改 20、增 5、删 5
    for (const rel of files.slice(0, 20)) fs.appendFileSync(path.join(work, rel), '// edit\n')
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(work, 'p0', `added${i}.ts`), 'new\n')
    for (const rel of files.slice(100, 105)) fs.rmSync(path.join(work, rel))
    const small = await timed(() => repo.checkpoint('small'))
    expect(small.result.created).toBe(true)

    // 大改动后恢复到首次检查点（改 1000、删 500）
    for (const rel of files.slice(1000, 2000)) fs.appendFileSync(path.join(work, rel), '// big\n')
    for (const rel of files.slice(3000, 3500)) fs.rmSync(path.join(work, rel))
    const restore = await timed(() => repo.restore(first.result.commit))
    expect(restore.result.changes.length).toBeGreaterThanOrEqual(1500)
    const undo = await timed(() => repo.restore(restore.result.before))

    console.log(
      `checkpoint perf (${process.platform}): first ${first.ms.toFixed(0)} ms, unchanged ` +
        `${unchanged.ms.toFixed(0)} ms, small ${small.ms.toFixed(0)} ms, restore ` +
        `${restore.ms.toFixed(0)} ms, undo ${undo.ms.toFixed(0)} ms`,
    )
    expect(unchanged.ms).toBeLessThan(2000)
    expect(small.ms).toBeLessThan(2000)
    expect(restore.ms).toBeLessThan(5000)
    expect(undo.ms).toBeLessThan(5000)
  })
})
