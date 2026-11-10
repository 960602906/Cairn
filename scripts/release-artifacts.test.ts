import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDependenciesManifest,
  extractChangelogSection,
  listInstalledPackages,
  main,
  readJson,
  releaseArtifacts,
  renderProvenance,
  renderReleaseNotes,
  renderUpdateMetadata,
  sha256,
  validateUpdateMetadata,
  writeChecksums,
} from './release-artifacts.mjs'

const dirs: string[] = []
const VERSION = '0.1.1'
const INSTALLER = `Cairn-${VERSION}-x64-setup.exe`

function temporaryDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cairn-release-'))
  dirs.push(dir)
  return dir
}

interface Fixture {
  readonly root: string
  readonly desktop: string
  readonly dist: string
  readonly env: Record<string, string>
}

function fixture(
  options: { channel?: 'stable' | 'beta'; commit?: string; changelog?: string } = {},
): Fixture {
  const root = temporaryDirectory()
  const desktop = path.join(root, 'apps/desktop')
  const dist = path.join(desktop, 'dist')
  const out = path.join(desktop, 'out')
  const stage = path.join(desktop, '.package/app')
  mkdirSync(dist, { recursive: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(
    path.join(desktop, 'package.json'),
    JSON.stringify({ name: '@cairn/desktop', version: VERSION }),
  )
  writeFileSync(
    path.join(out, 'build-info.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: VERSION,
      channel: options.channel ?? 'beta',
      commit: options.commit ?? 'abcdef1234567890',
      buildTime: '2026-11-10T08:30:00.000Z',
      electronVersion: '45.2.1',
      nodeVersion: '26.13.0',
    }),
  )
  writeFileSync(path.join(out, 'THIRD_PARTY_NOTICES.txt'), 'Cairn includes third-party software.\n')
  const installer = path.join(dist, INSTALLER)
  writeFileSync(installer, 'installer-bytes')
  writeFileSync(`${installer}.blockmap`, 'blockmap-bytes')
  const sha512 = createHash('sha512').update(readFileSync(installer)).digest('base64')
  writeFileSync(
    path.join(dist, 'latest.yml'),
    renderUpdateMetadata({
      version: VERSION,
      installer: INSTALLER,
      sha512,
      size: statSync(installer).size,
      releaseDate: '2026-11-10T08:30:00.000Z',
    }),
  )

  mkdirSync(path.join(stage, 'node_modules/foo'), { recursive: true })
  mkdirSync(path.join(stage, 'node_modules/@scope/bar'), { recursive: true })
  mkdirSync(path.join(stage, 'node_modules/foo/node_modules/nested'), { recursive: true })
  writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: '@cairn/desktop',
      version: VERSION,
      dependencies: { foo: '1.0.0', '@scope/bar': '2.0.0' },
    }),
  )
  writeFileSync(
    path.join(stage, 'node_modules/foo/package.json'),
    JSON.stringify({ name: 'foo', version: '1.0.0', license: 'MIT' }),
  )
  writeFileSync(
    path.join(stage, 'node_modules/@scope/bar/package.json'),
    JSON.stringify({ name: '@scope/bar', version: '2.0.0', license: 'ISC' }),
  )
  writeFileSync(
    path.join(stage, 'node_modules/foo/node_modules/nested/package.json'),
    JSON.stringify({ name: 'nested', version: '3.0.0' }),
  )
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  writeFileSync(
    path.join(root, 'scripts/bundled-binaries.json'),
    JSON.stringify({
      binaries: [
        {
          name: 'MinGit',
          version: '2.56.0.4',
          license: 'GPL-2.0-only',
          source: 'official MinGit',
        },
      ],
    }),
  )
  writeFileSync(
    path.join(root, 'CHANGELOG.md'),
    options.changelog ??
      [
        '# Changelog',
        '',
        '## [0.1.1] - 2026-11-10',
        '',
        '### Added',
        '',
        '- 发布流水线。',
        '',
        '## [0.1.0] - 2026-11-10',
        '',
        '- 首个版本。',
        '',
      ].join('\n'),
  )
  return { root, desktop, dist, env: { CAIRN_SIGN_MODE: 'none' } }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('changelog extraction', () => {
  it('extracts the requested version and stops at the next section', () => {
    const changelog =
      '# Changelog\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- thing\n\n## [1.2.2]\n\n- old\n'
    expect(extractChangelogSection(changelog, '1.2.3')).toBe('### Fixed\n\n- thing')
    expect(extractChangelogSection(changelog, '1.2.2')).toBe('- old')
  })

  it('rejects missing and empty sections', () => {
    expect(() => extractChangelogSection('## [1.0.0]\n\n- x\n', '2.0.0')).toThrow(/no section/)
    expect(() => extractChangelogSection('## [1.0.0]\n\n## [0.9.0]\n\n- x\n', '1.0.0')).toThrow(
      /empty/,
    )
  })
})

describe('json reading', () => {
  it('rejects JSON values that are not objects', () => {
    const directory = temporaryDirectory()
    writeFileSync(path.join(directory, 'array.json'), '[1, 2]')
    writeFileSync(path.join(directory, 'null.json'), 'null')
    expect(() => readJson(path.join(directory, 'array.json'))).toThrow(/not a JSON object/)
    expect(() => readJson(path.join(directory, 'null.json'))).toThrow(/not a JSON object/)
  })
})

describe('update metadata', () => {
  it('renders metadata that validates against the installer', () => {
    const file = path.join(temporaryDirectory(), 'installer.exe')
    writeFileSync(file, 'installer-bytes')
    const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64')
    const size = statSync(file).size
    const metadata = renderUpdateMetadata({
      version: VERSION,
      installer: INSTALLER,
      sha512,
      size,
      releaseDate: '2026-11-10T08:30:00.000Z',
    })
    expect(metadata).toContain(`version: "${VERSION}"`)
    expect(metadata).toContain(`size: ${size}`)
    expect(
      validateUpdateMetadata({
        metadata,
        version: VERSION,
        installer: INSTALLER,
        sha512,
        size,
      }),
    ).toEqual([])
  })

  it('reports every mismatch', () => {
    const metadata = [
      'version: "1.0.0"',
      'files:',
      '  - url: "other.exe"',
      '    sha512: "abc"',
      '    size: 1',
      'path: "other.exe"',
      'sha512: "abc"',
      "releaseDate: '2026-01-01T00:00:00.000Z'",
      '',
    ].join('\n')
    const problems = validateUpdateMetadata({
      metadata,
      version: VERSION,
      installer: INSTALLER,
      sha512: 'expected',
      size: 2,
    })
    expect(problems).toHaveLength(5)
    expect(problems.join('\n')).toMatch(/version/)
    expect(problems.join('\n')).toMatch(/path/)
    expect(problems.join('\n')).toMatch(/sha512/)
    expect(problems.join('\n')).toMatch(/size/)
    expect(problems.join('\n')).toMatch(/exactly the built installer/)
  })
})

describe('checksums and installed packages', () => {
  it('writes sorted SHA-256 checksums', () => {
    const directory = temporaryDirectory()
    writeFileSync(path.join(directory, 'b.txt'), 'b')
    writeFileSync(path.join(directory, 'a.txt'), 'a')
    expect(writeChecksums({ directory, files: ['b.txt', 'a.txt', 'a.txt'] })).toBe(2)
    const lines = readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n')
    expect(lines.map((line) => line.split('  ')[1])).toEqual(['a.txt', 'b.txt'])
    expect(lines[0]).toBe(`${sha256(path.join(directory, 'a.txt'))}  a.txt`)
  })

  it('lists flat, scoped and nested packages', () => {
    const { desktop } = fixture()
    const packages = listInstalledPackages(path.join(desktop, '.package/app/node_modules'))
    expect(packages).toEqual([
      { name: '@scope/bar', version: '2.0.0', license: 'ISC' },
      { name: 'foo', version: '1.0.0', license: 'MIT' },
      { name: 'nested', version: '3.0.0', license: '' },
    ])
    expect(listInstalledPackages(path.join(desktop, 'missing'))).toEqual([])
  })

  it('builds the dependency manifest with external binaries', () => {
    const { desktop, root } = fixture()
    const manifest = buildDependenciesManifest({
      stageDir: path.join(desktop, '.package/app'),
      bundled: readJson(path.join(root, 'scripts/bundled-binaries.json')),
      electronVersion: '45.2.1',
      nodeVersion: '26.13.0',
    })
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      electron: '45.2.1',
      node: '26.13.0',
      direct: ['@scope/bar', 'foo'],
    })
    expect(manifest['dependencies']).toHaveLength(3)
    expect(manifest['binaries']).toEqual([
      { name: 'MinGit', version: '2.56.0.4', license: 'GPL-2.0-only', source: 'official MinGit' },
    ])
  })
})

describe('release notes and provenance', () => {
  it('documents signed and unsigned releases differently', () => {
    const unsigned = renderReleaseNotes({
      version: VERSION,
      channel: 'beta',
      commit: 'abcdef1',
      buildTime: '2026-11-10T08:30:00.000Z',
      changelogSection: '- change',
      signing: { mode: 'none' },
      installer: INSTALLER,
      installerSha256: 'abc',
    })
    expect(unsigned).toContain('**unsigned beta**')
    expect(unsigned).toContain('SmartScreen')
    expect(unsigned).toContain('- change')
    expect(unsigned).toContain('beta.yml')

    const signed = renderReleaseNotes({
      version: VERSION,
      channel: 'stable',
      commit: 'abcdef1',
      buildTime: '2026-11-10T08:30:00.000Z',
      changelogSection: '- change',
      signing: { mode: 'pfx', publisher: 'CN=Cairn', timestampUrl: 'https://ts.example' },
      installer: INSTALLER,
      installerSha256: 'abc',
    })
    expect(signed).toContain('已签名（pfx）')
    expect(signed).toContain('CN=Cairn')
    expect(signed).toContain('latest.yml')
    expect(signed).not.toContain('SmartScreen')
  })

  it('records workflow and artifact metadata', () => {
    expect(
      renderProvenance({
        version: VERSION,
        channel: 'beta',
        commit: 'abcdef1',
        buildTime: '2026-11-10T08:30:00.000Z',
        signing: { mode: 'none' },
        artifacts: [{ name: 'x', sha256: 'a', size: 1 }],
        env: {
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_ID: '42',
          GITHUB_SERVER_URL: 'https://github.com',
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      version: VERSION,
      channel: 'beta',
      commit: 'abcdef1',
      buildTime: '2026-11-10T08:30:00.000Z',
      repository: 'owner/repo',
      workflow: 'local',
      runId: '42',
      runAttempt: '',
      serverUrl: 'https://github.com',
      signing: { mode: 'none' },
      artifacts: [{ name: 'x', sha256: 'a', size: 1 }],
    })
  })
})

describe('release artifact assembly', () => {
  it('assembles a beta release and checksums every file', () => {
    const { desktop, dist, env } = fixture()
    const result = releaseArtifacts({ desktopRoot: desktop, channel: 'beta', env })
    expect(result.metadata).toBe('beta.yml')
    expect(result.files).toEqual([
      INSTALLER,
      `${INSTALLER}.blockmap`,
      'SHA256SUMS',
      'THIRD_PARTY_NOTICES.txt',
      'beta.yml',
      'dependencies.json',
      'provenance.json',
      'release-notes.md',
    ])
    const provenance = readJson(path.join(dist, 'release/provenance.json'))
    const checksums = readFileSync(path.join(dist, 'release/SHA256SUMS'), 'utf8').trim().split('\n')
    expect(checksums).toHaveLength(7)
    expect(checksums.some((line) => line.endsWith('provenance.json'))).toBe(true)
    expect(provenance['signing']).toEqual({ mode: 'none' })
    expect(provenance['artifacts']).toHaveLength(6)
    expect(readFileSync(path.join(dist, 'release/release-notes.md'), 'utf8')).toContain(
      'unsigned beta',
    )
    expect(readJson(path.join(dist, 'release/dependencies.json'))['dependencies']).toHaveLength(3)
  })

  it('refuses unsigned stable builds and accepts signed ones', () => {
    const unsigned = fixture({ channel: 'stable' })
    expect(() =>
      releaseArtifacts({ desktopRoot: unsigned.desktop, channel: 'stable', env: unsigned.env }),
    ).toThrow(/must be signed/)

    const signed = fixture({ channel: 'stable' })
    const result = releaseArtifacts({
      desktopRoot: signed.desktop,
      channel: 'stable',
      env: {
        CAIRN_SIGN_MODE: 'pfx',
        CAIRN_UPDATE_PUBLISHER: 'CN=Cairn, O=Cairn',
        WINDOWS_CERTIFICATE: 'base64-pfx',
        WINDOWS_CERTIFICATE_PASSWORD: 'certificate-passphrase',
      },
    })
    expect(result.metadata).toBe('latest.yml')
    expect(readFileSync(path.join(signed.dist, 'release/release-notes.md'), 'utf8')).toContain(
      '已签名（pfx）',
    )
  })

  it('fails closed on version, channel, commit and metadata drift', () => {
    const version = fixture({ channel: 'beta' })
    expect(() =>
      releaseArtifacts({
        desktopRoot: version.desktop,
        channel: 'beta',
        version: '9.9.9',
        env: version.env,
      }),
    ).toThrow(/does not match/)

    const buildVersion = fixture({ channel: 'beta' })
    writeFileSync(
      path.join(buildVersion.desktop, 'out/build-info.json'),
      JSON.stringify({
        ...readJson(path.join(buildVersion.desktop, 'out/build-info.json')),
        version: '0.0.0',
      }),
    )
    expect(() =>
      releaseArtifacts({
        desktopRoot: buildVersion.desktop,
        channel: 'beta',
        env: buildVersion.env,
      }),
    ).toThrow(/build-info\.json version does not match/)

    const channel = fixture({ channel: 'beta' })
    writeFileSync(
      path.join(channel.desktop, 'out/build-info.json'),
      JSON.stringify({
        ...readJson(path.join(channel.desktop, 'out/build-info.json')),
        channel: 'stable',
      }),
    )
    expect(() =>
      releaseArtifacts({ desktopRoot: channel.desktop, channel: 'beta', env: channel.env }),
    ).toThrow(/channel does not match/)

    const commit = fixture({ channel: 'beta', commit: 'unknown' })
    expect(() =>
      releaseArtifacts({ desktopRoot: commit.desktop, channel: 'beta', env: commit.env }),
    ).toThrow(/no usable commit/)

    const metadata = fixture({ channel: 'beta' })
    writeFileSync(path.join(metadata.dist, 'latest.yml'), 'version: "0.0.0"\n')
    expect(() =>
      releaseArtifacts({ desktopRoot: metadata.desktop, channel: 'beta', env: metadata.env }),
    ).toThrow(/latest\.yml/)

    const missing = fixture({ channel: 'beta' })
    rmSync(path.join(missing.dist, INSTALLER))
    expect(() =>
      releaseArtifacts({ desktopRoot: missing.desktop, channel: 'beta', env: missing.env }),
    ).toThrow(/missing/)
  })

  it('fails when the changelog section is unavailable', () => {
    const { desktop, env } = fixture({
      channel: 'beta',
      changelog: '# Changelog\n\n## [0.1.0]\n\n- old\n',
    })
    expect(() => releaseArtifacts({ desktopRoot: desktop, channel: 'beta', env })).toThrow(
      /no section/,
    )
  })
})

describe('CLI', () => {
  it('validates the channel and reports success or failure', () => {
    const error = vi.fn()
    expect(main({ argv: ['--channel', 'nightly'], error })).toBe(1)

    const { desktop, dist, env } = fixture()
    const log = vi.fn()
    expect(
      main({
        argv: ['--channel', 'beta', '--dist', dist],
        desktopRoot: desktop,
        env,
        log,
      }),
    ).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('update metadata beta.yml'))

    const stable = fixture({ channel: 'stable' })
    expect(
      main({
        argv: ['--channel', 'stable'],
        desktopRoot: stable.desktop,
        env: stable.env,
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('must be signed'))
  })

  it('prints to the console when no logger is injected', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { desktop, dist, env } = fixture()
      expect(main({ argv: ['--channel', 'beta', '--dist', dist], desktopRoot: desktop, env })).toBe(
        0,
      )
      expect(main({ argv: ['--channel', 'nightly'] })).toBe(1)
      expect(log).toHaveBeenCalled()
      expect(error).toHaveBeenCalled()
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })
})
