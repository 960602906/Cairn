import { describe, expect, it } from 'vitest'
import {
  commandPatternToRegExp,
  matchCommand,
  normalizeCommand,
  parseCommand,
} from './command-match.js'

describe('parseCommand', () => {
  it.each([
    ['npm test', ['npm test'], true],
    ['  npm   test  ', ['npm test'], true],
    ['npm install && npm test', ['npm install', 'npm test'], true],
    ['a; b || c | d & e\nf\r\ng', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], true],
    ['echo "a && b"; ls', ['echo "a && b"', 'ls'], true],
    ["echo 'a | b'", ["echo 'a | b'"], true],
    ['echo $(rm -rf ~)', ['echo $(rm -rf ~)'], false],
    ['echo `whoami`', ['echo `whoami`'], false],
    ['echo "$(whoami)"', ['echo "$(whoami)"'], false],
    ['echo "`whoami`"', ['echo "`whoami`"'], false],
    ["echo '$(whoami)'", ["echo '$(whoami)'"], true],
    ['diff <(ls a) b', ['diff <(ls a) b'], false],
    ['tee >(cat)', ['tee >(cat)'], false],
    ['echo "unclosed', ['echo "unclosed'], false],
    ['echo $HOME > out.txt', ['echo $HOME > out.txt'], true],
    ['', [], true],
  ])('%j', (command, segments, reliable) => {
    expect(parseCommand(command)).toEqual({
      normalized: normalizeCommand(command),
      segments,
      reliable,
    })
  })
})

describe('commandPatternToRegExp', () => {
  it('`*` 是通配符，`\\*` 是字面的 `*`，其余按字面', () => {
    expect(commandPatternToRegExp('git status*').test('git status -s')).toBe(true)
    expect(commandPatternToRegExp('git status*').test('git statu')).toBe(false)
    expect(commandPatternToRegExp('ls \\*.ts').test('ls *.ts')).toBe(true)
    expect(commandPatternToRegExp('ls \\*.ts').test('ls a.ts')).toBe(false)
    expect(commandPatternToRegExp('dir C:\\temp').test('dir C:\\temp')).toBe(true)
    expect(commandPatternToRegExp('a.b (c)? [d] {e} ^$|+').test('a.b (c)? [d] {e} ^$|+')).toBe(true)
    expect(commandPatternToRegExp('a.b').test('axb')).toBe(false)
    expect(commandPatternToRegExp('  npm   test ').test('npm test')).toBe(true)
    expect(commandPatternToRegExp('NPM test', true).test('npm TEST')).toBe(true)
  })
})

describe('matchCommand', () => {
  const p = parseCommand
  it('every：可靠拆分且每段都匹配', () => {
    expect(matchCommand(p('npm test'), ['npm test'], 'every')).toBe(true)
    expect(matchCommand(p('npm test && rm -rf ~'), ['npm test*'], 'every')).toBe(false)
    expect(matchCommand(p('npm i && npm test'), ['npm i', 'npm test'], 'every')).toBe(true)
    expect(matchCommand(p('npm test $(rm -rf ~)'), ['npm test*'], 'every')).toBe(false)
    expect(matchCommand(p(''), ['*'], 'every')).toBe(false)
  })

  it('any：任一段或整条命令匹配', () => {
    expect(matchCommand(p('ls; rm -rf /'), ['rm -rf*'], 'any')).toBe(true)
    expect(matchCommand(p('a && b'), ['a && b'], 'any')).toBe(true)
    expect(matchCommand(p('ls'), ['rm*'], 'any')).toBe(false)
    expect(matchCommand(p('RM x'), ['rm*'], 'any', true)).toBe(true)
  })
})
