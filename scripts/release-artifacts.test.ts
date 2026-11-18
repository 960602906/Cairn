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
  parseUpdateMetadata,
  platformSpec,
  readJson,
  releaseArtifacts,
  renderProvenance,
  renderReleaseNotes,
  renderUpdateMetadata,
  renderUpdateMetadataFiles,
  sha256,
  validateUpdateMetadata,
  validateUpdateMetadataFiles,
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

function addPlatformArtifacts(
  target: Fixture,
  platform: 'mac' | 'linux',
  channel: 'stable' | 'beta' = 'beta',
): void {
  const names =
    platform === 'mac'
      ? ['arm64', 'x64'].flatMap((arch) => [
          `Cairn-${VERSION}-${arch}.dmg`,
          `Cairn-${VERSION}-${arch}.zip`,
        ])
      : [`Cairn-${VERSION}-x64.AppImage`, `Cairn-${VERSION}-x64.deb`]
  for (const name of names) writeFileSync(path.join(target.dist, name), `${name}-bytes`)
  const updatable =
    platform === 'mac'
      ? ['arm64', 'x64'].map((arch) => `Cairn-${VERSION}-${arch}.zip`)
      : [`Cairn-${VERSION}-x64.AppImage`]
  if (platform === 'mac') {
    for (const arch of ['arm64', 'x64']) {
      writeFileSync(path.join(target.dist, `Cairn-${VERSION}-${arch}.zip.blockmap`), 'blockmap')
    }
  }
  // electron-builder 26 把同平台全部产物写进元数据（mac 含 dmg、Linux 含 deb），
  // 更新载体排在前面；这里按同样的形状生成，才能覆盖真实产物。
  const files = [...updatable, ...names.filter((name) => !updatable.includes(name))].map((name) => {
    const file = path.join(target.dist, name)
    return {
      name,
      sha512: createHash('sha512').update(readFileSync(file)).digest('base64'),
      size: statSync(file).size,
    }
  })
  writeFileSync(
    path.join(target.dist, platform === 'mac' ? 'latest-mac.yml' : 'latest-linux.yml'),
    renderUpdateMetadataFiles({
      version: VERSION,
      files,
      releaseDate: '2026-11-10T08:30:00.000Z',
    }),
  )
  writeFileSync(
    path.join(target.desktop, 'out/build-info.json'),
    JSON.stringify({
      ...readJson(path.join(target.desktop, 'out/build-info.json')),
      channel,
    }),
  )
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
      'platform-notes.json',
      'provenance.json',
      'release-notes.md',
    ])
    const provenance = readJson(path.join(dist, 'release/provenance.json'))
    const checksums = readFileSync(path.join(dist, 'release/SHA256SUMS'), 'utf8').trim().split('\n')
    expect(checksums).toHaveLength(8)
    expect(checksums.some((line) => line.endsWith('provenance.json'))).toBe(true)
    expect(provenance['platform']).toBe('windows')
    expect(provenance['signing']).toEqual({ mode: 'none' })
    expect(provenance['artifacts']).toHaveLength(7)
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

  it('assembles a macOS release with latest-mac.yml and both architectures', () => {
    const mac = fixture({ channel: 'beta' })
    addPlatformArtifacts(mac, 'mac')
    const result = releaseArtifacts({
      desktopRoot: mac.desktop,
      channel: 'beta',
      platform: 'mac',
      env: mac.env,
    })
    expect(result.metadata).toBe('beta-mac.yml')
    expect(result.files).toContain(`Cairn-${VERSION}-arm64.dmg`)
    expect(result.files).toContain(`Cairn-${VERSION}-x64.zip.blockmap`)
    expect(result.platformNotes['platform']).toBe('mac')
    const notes = readFileSync(path.join(mac.dist, 'release/release-notes.md'), 'utf8')
    expect(notes).toContain('macOS')
    expect(notes).toContain('Gatekeeper')
    expect(notes).toContain('beta-mac.yml')
    expect(notes).toContain(`Cairn-${VERSION}-arm64.dmg`)
  })

  it('allows unsigned stable Linux releases and documents their integrity model', () => {
    const linux = fixture({ channel: 'stable' })
    addPlatformArtifacts(linux, 'linux', 'stable')
    const result = releaseArtifacts({
      desktopRoot: linux.desktop,
      channel: 'stable',
      platform: 'linux',
      env: { CAIRN_SIGN_MODE: 'none' },
    })
    expect(result.metadata).toBe('latest-linux.yml')
    const notes = readFileSync(path.join(linux.dist, 'release/release-notes.md'), 'utf8')
    expect(notes).toContain('**未签名**')
    expect(notes).toContain('HTTPS')
    expect(notes).not.toContain('SmartScreen')
    expect(result.platformNotes['signing']).toEqual({ mode: 'none', integrity: 'sha256+https' })

    const withoutDownloads = renderReleaseNotes({
      version: VERSION,
      channel: 'beta',
      commit: 'abcdef1',
      buildTime: '2026-11-10T08:30:00.000Z',
      changelogSection: '- change',
      signing: { mode: 'none' },
      platform: 'linux',
    })
    expect(withoutDownloads).toContain('未签名')
    expect(withoutDownloads).not.toContain('- 安装包：')
  })

  it('refuses unsigned stable macOS releases and accepts Developer ID builds', () => {
    const unsigned = fixture({ channel: 'stable' })
    addPlatformArtifacts(unsigned, 'mac', 'stable')
    expect(() =>
      releaseArtifacts({
        desktopRoot: unsigned.desktop,
        channel: 'stable',
        platform: 'mac',
        env: { CAIRN_MAC_SIGN_MODE: 'none' },
      }),
    ).toThrow(/must be signed/)

    const signed = fixture({ channel: 'stable' })
    addPlatformArtifacts(signed, 'mac', 'stable')
    const result = releaseArtifacts({
      desktopRoot: signed.desktop,
      channel: 'stable',
      platform: 'mac',
      env: {
        CAIRN_MAC_SIGN_MODE: 'developer-id',
        CAIRN_MAC_IDENTITY: 'Developer ID Application: Cairn (TEAMID)',
        MAC_CERTIFICATE: 'CERTIFICATE_VALUE',
        MAC_CERTIFICATE_PASSWORD: 'PASSWORD_VALUE',
        APPLE_ID: 'release@example.invalid',
        APPLE_APP_SPECIFIC_PASSWORD: 'APPLE_VALUE',
        APPLE_TEAM_ID: 'TEAMID',
      },
    })
    expect(result.metadata).toBe('latest-mac.yml')
    const notes = readFileSync(path.join(signed.dist, 'release/release-notes.md'), 'utf8')
    expect(notes).toContain('已签名（developer-id）并公证')
    expect(notes).toContain('Developer ID Application: Cairn (TEAMID)')
  })

  it('fails when a platform artifact or its metadata is missing', () => {
    const mac = fixture({ channel: 'beta' })
    addPlatformArtifacts(mac, 'mac')
    rmSync(path.join(mac.dist, `Cairn-${VERSION}-x64.dmg`))
    expect(() =>
      releaseArtifacts({
        desktopRoot: mac.desktop,
        channel: 'beta',
        platform: 'mac',
        env: mac.env,
      }),
    ).toThrow(/missing/)

    const linux = fixture({ channel: 'beta' })
    addPlatformArtifacts(linux, 'linux')
    rmSync(path.join(linux.dist, 'latest-linux.yml'))
    expect(() =>
      releaseArtifacts({
        desktopRoot: linux.desktop,
        channel: 'beta',
        platform: 'linux',
        env: linux.env,
      }),
    ).toThrow(/latest-linux\.yml/)
  })

  it('validates multi-file update metadata against every updatable artifact', () => {
    const files = [
      { name: 'a.zip', sha512: 'aaa', size: 1 },
      { name: 'b.zip', sha512: 'bbb', size: 2 },
    ]
    const metadata = renderUpdateMetadataFiles({
      version: VERSION,
      files,
      releaseDate: '2026-11-10T08:30:00.000Z',
    })
    expect(validateUpdateMetadataFiles({ metadata, version: VERSION, files })).toEqual([])

    const withExtra = renderUpdateMetadataFiles({
      version: VERSION,
      files: [...files, { name: 'extra.dmg', sha512: 'ddd', size: 4 }],
      releaseDate: '',
    })
    expect(validateUpdateMetadataFiles({ metadata: withExtra, version: VERSION, files })).toEqual([
      'update metadata references an unexpected file: extra.dmg',
    ])
    expect(
      validateUpdateMetadataFiles({
        metadata: withExtra,
        version: VERSION,
        files,
        allowedExtra: ['extra.dmg'],
      }),
    ).toEqual([])

    expect(
      validateUpdateMetadataFiles({
        metadata,
        version: '9.9.9',
        files: [files[0]!, { name: 'c.zip', sha512: 'ccc', size: 3 }],
      }),
    ).toEqual([
      'update metadata version does not match the build',
      'update metadata references an unexpected file: b.zip',
      'update metadata does not reference c.zip',
    ])

    const driftedFiles = [{ name: 'a.zip', sha512: 'wrong', size: 99 }]
    expect(
      validateUpdateMetadataFiles({
        metadata: renderUpdateMetadataFiles({
          version: VERSION,
          files: driftedFiles,
          releaseDate: '',
        }),
        version: VERSION,
        files: [files[0]!],
      }),
    ).toEqual([
      'update metadata sha512 does not match a.zip',
      'update metadata size does not match a.zip',
      'update metadata top-level sha512 does not match the primary file',
    ])

    expect(
      validateUpdateMetadataFiles({
        metadata: `version: "${VERSION}"\nfiles:\n`,
        version: VERSION,
        files: [files[0]!],
      }).join('\n'),
    ).toMatch(/does not reference a\.zip[\s\S]*path does not reference/)

    const drifted = metadata.replace('path: "a.zip"', 'path: "b.zip"')
    expect(
      validateUpdateMetadataFiles({
        metadata: drifted,
        version: VERSION,
        files: [files[0]!],
      }).join('\n'),
    ).toMatch(/path does not reference/)

    expect(() =>
      renderUpdateMetadataFiles({ version: VERSION, files: [], releaseDate: '' }),
    ).toThrow(/at least one file/)

    expect(platformSpec('linux').builderMetadata).toBe('latest-linux.yml')
    expect(() => platformSpec('solaris')).toThrow(/unsupported release platform/)

    expect(parseUpdateMetadata('version: "0.1.1"\nfiles:\n  - url: a.zip\n').files).toEqual([
      { url: 'a.zip', sha512: '', size: 0 },
    ])
  })

  it('tolerates build metadata without a build time', () => {
    const windows = fixture({ channel: 'beta' })
    const buildInfo = readJson(path.join(windows.desktop, 'out/build-info.json'))
    delete buildInfo['buildTime']
    writeFileSync(path.join(windows.desktop, 'out/build-info.json'), JSON.stringify(buildInfo))
    const result = releaseArtifacts({
      desktopRoot: windows.desktop,
      channel: 'beta',
      env: windows.env,
    })
    expect(readFileSync(path.join(windows.dist, 'release/beta.yml'), 'utf8')).toContain(
      'releaseDate: ""',
    )
    expect(result.platformNotes['buildTime']).toBe('')
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
    expect(main({ argv: ['--channel', 'beta', '--platform', 'solaris'], error })).toBe(1)

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
