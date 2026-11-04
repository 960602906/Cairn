import { createTwoFilesPatch } from 'diff'
for (const n of [3000, 20000]) {
  const a = Array.from({ length: n }, (_, i) => `line ${i} ${'z'.repeat(20)}`).join('\n')
  const b = a.replaceAll('z', 'Z')
  let t = Date.now()
  createTwoFilesPatch('a', 'b', a, b)
  console.log(n, 'all changed', Date.now() - t)
  const c = a.replace('line 5 ', 'LINE 5 ')
  t = Date.now()
  createTwoFilesPatch('a', 'b', a, c)
  console.log(n, 'one changed', Date.now() - t)
  t = Date.now()
  const r = createTwoFilesPatch('a', 'b', a, b, undefined, undefined, { timeout: 200 })
  console.log(n, 'timeout', Date.now() - t, r === undefined)
}
