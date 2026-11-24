import { describe, expect, it } from 'vitest'
import { matchCommand, parseCommand } from './command-match.js'
import { assessCommand, tokenize } from './permission-guards.js'
import { isSpecificCommandPattern } from './permissions.js'

describe('权限审查回归', () => {
  it('反斜杠转义的引号不会把多条命令藏进一段', () => {
    const cmd = "echo \\'; rm -rf ~; echo \\'"
    const parsed = parseCommand(cmd)
    expect(parsed.reliable).toBe(false)
    expect(matchCommand(parsed, ['echo *'], 'every')).toBe(false)
    expect(assessCommand(cmd)?.effect).toBe('deny')
  })

  it('普通转义仍正常处理', () => {
    expect(parseCommand('grep a\\.b src').reliable).toBe(true)
    expect(tokenize('rm -rf my\\ dir')).toEqual(['rm', '-rf', 'my dir'])
  })

  it('重定向到文件时 allow 规则不匹配', () => {
    expect(matchCommand(parseCommand('echo x > ../../out.txt'), ['echo *'], 'every')).toBe(false)
    expect(matchCommand(parseCommand('cat < secret'), ['cat *'], 'every')).toBe(false)
  })

  it('fd 复制与丢弃输出不影响 allow', () => {
    for (const c of [
      'npm test 2>&1',
      'npm test >/dev/null',
      'npm test 2> /dev/null',
      'npm test >$null',
    ]) {
      expect(matchCommand(parseCommand(c), ['npm test*'], 'every')).toBe(true)
    }
  })

  it('只写命令名的宽泛模式不能取消危险命令询问', () => {
    for (const p of ['*', 'git *', 'git*', 'sudo *'])
      expect(isSpecificCommandPattern(p)).toBe(false)
    for (const p of ['git push*', 'git push origin main', 'npm publish']) {
      expect(isSpecificCommandPattern(p)).toBe(true)
    }
  })
})
