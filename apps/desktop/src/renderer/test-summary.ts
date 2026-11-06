/**
 * 终端卡片底部的测试汇总（M2-06，视觉规范 §7.3）：从命令输出（已去掉 ANSI）的汇总行识别通过、失败、
 * 跳过数量。支持 vitest、jest、pytest、cargo test；有多处汇总时取最后一处。识别不了时返回 undefined。
 */
export interface TestSummary {
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

const SUMMARY_LINES = [
  // vitest：`      Tests  12 passed | 1 failed | 2 skipped (15)`
  /^\s*Tests\s{2,}(.+?)\s*\(\d+\)\s*$/gm,
  // jest：`Tests:       1 failed, 2 skipped, 12 passed, 15 total`
  /^\s*Tests:\s+(.+?)$/gm,
  // pytest：`==== 12 passed, 1 failed, 2 skipped in 0.12s ====`
  /^=+ (.+?) in [\d.]+s(?: \([^)]*\))? =+$/gm,
  // cargo：`test result: FAILED. 12 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out`
  /^test result: \w+\. (.+?)$/gm,
]

const COUNT = /(\d+) (passed|failed|skipped|ignored|todo|pending|errors?|xfailed|xpassed)\b/g

export function summarizeTests(text: string): TestSummary | undefined {
  let best: { index: number; body: string } | undefined
  for (const pattern of SUMMARY_LINES) {
    for (const match of text.matchAll(pattern)) {
      if (!best || match.index > best.index) best = { index: match.index, body: match[1]! }
    }
  }
  if (!best) return undefined
  const summary = { passed: 0, failed: 0, skipped: 0 }
  let found = false
  for (const [, count, kind] of best.body.matchAll(COUNT)) {
    found = true
    const n = Number(count)
    if (kind === 'passed' || kind === 'xpassed') summary.passed += n
    else if (kind === 'failed' || kind!.startsWith('error')) summary.failed += n
    else summary.skipped += n
  }
  return found ? summary : undefined
}
