import { describe, expect, it, vi } from 'vitest'
import {
  createLogger,
  DEFAULT_LOG_MAX_BYTES,
  isLogLevel,
  logFilePath,
  parseLogLevel,
  type LogFileSystem,
  type LoggerOptions,
} from './logger.js'
import { createRedactor, REDACTED } from './redact.js'

class MemoryFs implements LogFileSystem {
  readonly files = new Map<string, string>()
  failNext = false

  appendFile(path: string, data: string): void {
    if (this.failNext) {
      this.failNext = false
      throw new Error('disk full')
    }
    this.files.set(path, (this.files.get(path) ?? '') + data)
  }
  fileSize(path: string): number {
    return new TextEncoder().encode(this.files.get(path) ?? '').length
  }
  rename(from: string, to: string): void {
    const data = this.files.get(from)
    if (data === undefined) return
    this.files.set(to, data)
    this.files.delete(from)
  }
  remove(path: string): void {
    this.files.delete(path)
  }
  lines(path: string): Record<string, unknown>[] {
    return (this.files.get(path) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }
}

const FILE = '/logs/main.log'

function setup(overrides: Partial<LoggerOptions> = {}) {
  const fs = new MemoryFs()
  const logger = createLogger({
    processName: 'main',
    dir: '/logs/',
    fs,
    now: () => 0,
    ...overrides,
  })
  return { fs, logger }
}

describe('createLogger', () => {
  it('writes JSON lines with fixed fields first', () => {
    const { fs, logger } = setup()
    logger.info('session opened', { sessionId: 's1', count: 2 })
    expect(fs.files.get(FILE)).toBe(
      '{"ts":"1970-01-01T00:00:00.000Z","level":"info","proc":"main","msg":"session opened","sessionId":"s1","count":2}\n',
    )
  })

  it('does not let fields override fixed fields', () => {
    const { fs, logger } = setup()
    logger.warn('real', { msg: 'fake', level: 'debug', ts: 'x', proc: 'y' })
    expect(fs.lines(FILE)).toEqual([
      { ts: '1970-01-01T00:00:00.000Z', level: 'warn', proc: 'main', msg: 'real' },
    ])
  })

  it('filters by level and can change it at runtime', () => {
    const { fs, logger } = setup({ level: 'warn' })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(logger.isEnabled('info')).toBe(false)
    logger.setLevel('debug')
    expect(logger.level).toBe('debug')
    logger.debug('d2')
    expect(fs.lines(FILE).map((l) => l.msg)).toEqual(['w', 'e', 'd2'])
  })

  it('defaults to info level', () => {
    const { logger } = setup()
    expect(logger.level).toBe('info')
    expect(logger.isEnabled('debug')).toBe(false)
  })

  it('redacts records before writing', () => {
    const redact = createRedactor({ homeDirs: ['/home/lan'], secrets: ['configured-key-123'] })
    const { fs, logger } = setup({ redact })
    logger.error('request failed for configured-key-123', {
      url: 'https://api.example.com?key=abc123',
      cwd: '/home/lan/project',
      headers: { authorization: 'Bearer abcdefgh12345678' },
      error: new Error('boom sk-0123456789abcdef0123'),
    })
    const [line] = fs.lines(FILE)
    expect(line).toMatchObject({
      msg: `request failed for ${REDACTED}`,
      url: `https://api.example.com?key=${REDACTED}`,
      cwd: '~/project',
      headers: { authorization: REDACTED },
      error: { name: 'Error', message: `boom ${REDACTED}` },
    })
  })

  it('uses default redaction rules when none are given', () => {
    const { fs, logger } = setup()
    logger.info('x', { apiKey: 'plain' })
    expect(fs.lines(FILE)[0]).toMatchObject({ apiKey: REDACTED })
  })

  it('creates child loggers with bindings that share level and file', () => {
    const { fs, logger } = setup()
    const child = logger.child({ sessionId: 's1' }).child({ runId: 'r1' })
    child.info('step', { stepId: 'st1' })
    logger.setLevel('error')
    expect(child.level).toBe('error')
    child.info('hidden')
    expect(fs.lines(FILE)).toEqual([
      {
        ts: '1970-01-01T00:00:00.000Z',
        level: 'info',
        proc: 'main',
        msg: 'step',
        sessionId: 's1',
        runId: 'r1',
        stepId: 'st1',
      },
    ])
  })

  it('separates processes by file name', () => {
    const fs = new MemoryFs()
    createLogger({ processName: 'main', dir: 'C:\\logs', fs }).info('a')
    createLogger({ processName: 'host', dir: 'C:\\logs', fs }).info('b')
    expect([...fs.files.keys()].sort()).toEqual(['C:\\logs/host.log', 'C:\\logs/main.log'])
  })
})

describe('rotation', () => {
  const line = (msg: string) =>
    `{"ts":"1970-01-01T00:00:00.000Z","level":"info","proc":"main","msg":"${msg}"}\n`
  const lineBytes = line('m0').length

  it('rotates when the next line would exceed maxBytes, keeping maxFiles', () => {
    const { fs, logger } = setup({ maxBytes: lineBytes * 2, maxFiles: 2 })
    for (let i = 0; i < 7; i++) logger.info(`m${i}`)
    expect(fs.files.get(FILE)).toBe(line('m6'))
    expect(fs.files.get(`${FILE}.1`)).toBe(line('m4') + line('m5'))
    expect(fs.files.get(`${FILE}.2`)).toBe(line('m2') + line('m3'))
    expect(fs.files.has(`${FILE}.3`)).toBe(false)
  })

  it('takes the existing file size into account', () => {
    const { fs, logger } = setup({ maxBytes: lineBytes * 2 })
    fs.files.set(FILE, line('old') + line('ol'))
    logger.info('m0')
    expect(fs.files.get(FILE)).toBe(line('m0'))
    expect(fs.files.get(`${FILE}.1`)).toBe(line('old') + line('ol'))
  })

  it('counts UTF-8 bytes', () => {
    const { fs, logger } = setup({ maxBytes: lineBytes + 10 })
    logger.info('中文') // 2 个汉字 = 6 字节，比 m0 多 4 字节
    logger.info('m0')
    expect(fs.files.get(`${FILE}.1`)).toBe(line('中文'))
    logger.info('😀😀😀') // 每个 4 字节
    expect(fs.files.get(`${FILE}.1`)).toBe(line('m0'))
    expect(fs.files.get(FILE)).toBe(line('😀😀😀'))
  })

  it('writes an oversized line into an empty file instead of rotating forever', () => {
    const { fs, logger } = setup({ maxBytes: 10 })
    logger.info('long line')
    logger.info('next')
    expect(fs.files.get(FILE)).toBe(line('next'))
    expect(fs.files.get(`${FILE}.1`)).toBe(line('long line'))
  })

  it('truncates instead of keeping history when maxFiles is 0', () => {
    const { fs, logger } = setup({ maxBytes: lineBytes, maxFiles: 0 })
    logger.info('m0')
    logger.info('m1')
    expect([...fs.files.keys()]).toEqual([FILE])
    expect(fs.files.get(FILE)).toBe(line('m1'))
  })

  it('uses a 5 MiB limit by default', () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    const { fs, logger } = setup()
    logger.info('m0')
    expect(fs.files.has(`${FILE}.1`)).toBe(false)
  })
})

describe('write failures', () => {
  it('never throws, reports the error and re-reads the size afterwards', () => {
    const onWriteError = vi.fn()
    const { fs, logger } = setup({ onWriteError })
    fs.failNext = true
    expect(() => logger.info('lost')).not.toThrow()
    expect(onWriteError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
    const size = vi.spyOn(fs, 'fileSize')
    logger.info('kept')
    expect(size).toHaveBeenCalledTimes(1)
    expect(fs.lines(FILE).map((l) => l.msg)).toEqual(['kept'])
  })

  it('ignores failures silently by default', () => {
    const { fs, logger } = setup()
    fs.failNext = true
    expect(() => logger.error('x')).not.toThrow()
  })
})

describe('helpers', () => {
  it('parses log levels', () => {
    expect(parseLogLevel(' DEBUG ')).toBe('debug')
    expect(parseLogLevel('verbose')).toBe('info')
    expect(parseLogLevel(undefined, 'warn')).toBe('warn')
    expect(isLogLevel('error')).toBe(true)
    expect(isLogLevel(3)).toBe(false)
  })

  it('builds log file paths', () => {
    expect(logFilePath('/var/log/nexus//', 'host')).toBe('/var/log/nexus/host.log')
    expect(logFilePath('C:\\data\\logs\\', 'main')).toBe('C:\\data\\logs/main.log')
  })
})
