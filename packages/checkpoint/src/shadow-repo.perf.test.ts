/**
 * 性能验收（M1-12，S5）：约 1 万个文件的工作区上，日常检查点 < 2 s、恢复 < 5 s。
 * 只在 CI 中运行（`CI` 环境变量），Windows 是首发平台。首次检查点（每个项目一次）与大改动之后的
 * 检查点只记录耗时（S5：Windows 上约 12 s、4 s）；恢复取 3 轮的中位数。
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

    // 大改动（改 1000、删 500）之后的检查点：每轮开始与每次命令前都会创建，恢复时不再包含这部分
    for (const rel of files.slice(1000, 2000)) fs.appendFileSync(path.join(work, rel), '// big\n')
    for (const rel of files.slice(3000, 3500)) fs.rmSync(path.join(work, rel))
    const big = await timed(() => repo.checkpoint('big'))

    // 恢复到首次检查点再撤销，取 3 轮的中位数（与 S5 相同）
    const restores: number[] = []
    const undos: number[] = []
    for (let round = 0; round < 3; round++) {
      const restore = await timed(() => repo.restore(first.result.commit))
      expect(restore.result.changes.length).toBeGreaterThanOrEqual(1500)
      restores.push(restore.ms)
      undos.push((await timed(() => repo.restore(restore.result.before))).ms)
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!

    const ms = (n: number) => `${n.toFixed(0)} ms`
    console.log(
      `checkpoint perf (${process.platform}): first ${ms(first.ms)}, unchanged ${ms(unchanged.ms)}, ` +
        `small ${ms(small.ms)}, big ${ms(big.ms)}, restore ${restores.map(ms).join(' / ')}, ` +
        `undo ${undos.map(ms).join(' / ')}`,
    )
    expect(unchanged.ms).toBeLessThan(2000)
    expect(small.ms).toBeLessThan(2000)
    expect(median(restores)).toBeLessThan(5000)
    expect(median(undos)).toBeLessThan(5000)
  })
})
