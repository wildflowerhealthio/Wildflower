import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { parse } from 'yaml'

// The script under test lives in `.devcontainer/`, which belongs to no
// workspace package — so its tests live here with the other repo-tooling tests
// rather than next to it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, '.devcontainer', 'install-global-tools.sh')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-global-tools-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const LOCKFILE_LINES: ReadonlyArray<string> = [
  "lockfileVersion: '9.0'",
  '',
  'catalogs:',
  '  default:',
  "    '@tsdown/css':",
  '      specifier: ^0.23.7',
  '      version: 0.23.9',
  '    typescript:',
  '      specifier: 5.9.3',
  '      version: 5.9.3',
  '    typescript-7:',
  '      specifier: npm:typescript@7.0.2',
  '      version: 7.0.2',
  '    vite:',
  '      specifier: npm:@voidzero-dev/vite-plus-core@1.6.0',
  '      version: 1.6.0',
  '    vite-plus:',
  '      specifier: 1.6.0',
  '      version: 1.6.0',
  '',
  'importers:',
  '',
  '  .:',
  '    devDependencies:',
  '      vite-plus:',
  "        specifier: 'catalog:'",
  '        version: 9.9.9(typescript@5.9.3)',
  '',
]

const SPECS = 'vite-plus@1.6.0 typescript@7.0.2 @tsdown/css@0.23.9'

const lockfile = (contents: string): string => {
  const path = join(dir, 'pnpm-lock.yaml')
  writeFileSync(path, contents)
  return path
}

const executable = (path: string, body: string): void => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`)
  chmodSync(path, 0o755)
}

// A PATH whose `pnpm` records its arguments and, given a version, whose `vp`
// reports it, ahead of the system tools the script needs.
const fakeToolsPath = (vpVersion: string | null): string => {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  executable(join(bin, 'pnpm'), `echo "$*" >> "${join(dir, 'pnpm.log')}"\n`)
  if (vpVersion !== null) {
    executable(join(bin, 'vp'), `echo "vp v${vpVersion}"\necho\necho "Tools:"\n`)
  }
  return `${bin}:/usr/bin:/bin`
}

const pnpmCalls = (): string => {
  const log = join(dir, 'pnpm.log')
  return existsSync(log) ? readFileSync(log, 'utf8') : ''
}

const run = (
  args: ReadonlyArray<string>,
  path?: string
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: path === undefined ? process.env : { ...process.env, PATH: path },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const CatalogVersions = Schema.Struct({
  catalogs: Schema.Struct({
    default: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({ version: Schema.String }),
    }),
  }),
})

describe('install-global-tools.sh --print', () => {
  it('prints each tool at the version the lockfile resolves, not the catalog range', () => {
    expect(run(['--print', lockfile(LOCKFILE_LINES.join('\n'))])).toEqual({
      status: 0,
      stdout: `${SPECS}\n`,
      stderr: '',
    })
  })

  it('reads a CRLF lockfile the same as an LF one', () => {
    expect(run(['--print', lockfile(LOCKFILE_LINES.join('\r\n'))]).stdout).toBe(`${SPECS}\n`)
  })

  it('matches the catalog versions in the repository lockfile', () => {
    const versions = Schema.decodeUnknownSync(CatalogVersions)(
      parse(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'))
    ).catalogs.default

    expect(run(['--print']).stdout).toBe(
      `vite-plus@${versions['vite-plus']?.version} ` +
        `typescript@${versions['typescript-7']?.version} ` +
        `@tsdown/css@${versions['@tsdown/css']?.version}\n`
    )
  })

  it('fails, naming the entry, when the catalog lacks one of the tools', () => {
    const path = lockfile(
      [
        'catalogs:',
        '  default:',
        '    vite-plus:',
        '      specifier: 1.6.0',
        '      version: 1.6.0',
        '',
        'importers:',
        '',
        '  .:',
        '    devDependencies:',
        '      typescript-7:',
        "        specifier: 'catalog:'",
        '        version: typescript@7.0.2',
        '',
      ].join('\n')
    )

    const result = run(['--print', path])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no resolved version for catalog entry typescript-7')
  })

  it('fails when there is no lockfile at the path', () => {
    const result = run(['--print', join(dir, 'missing.yaml')])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no lockfile at')
  })
})

describe('install-global-tools.sh', () => {
  it('installs the specs when there is no global vp', () => {
    const result = run([lockfile(LOCKFILE_LINES.join('\n'))], fakeToolsPath(null))

    expect(result.status).toBe(0)
    expect(pnpmCalls()).toBe(`install -g ${SPECS}\n`)
  })

  it('reinstalls when the global vp reports another version', () => {
    const result = run([lockfile(LOCKFILE_LINES.join('\n'))], fakeToolsPath('1.5.0'))

    expect(result.status).toBe(0)
    expect(pnpmCalls()).toBe(`install -g ${SPECS}\n`)
  })

  it('skips the install when the global vp already reports the lockfile version', () => {
    const result = run([lockfile(LOCKFILE_LINES.join('\n'))], fakeToolsPath('1.6.0'))

    expect(result).toEqual({
      status: 0,
      stdout: 'install-global-tools: global vp is already 1.6.0\n',
      stderr: '',
    })
    expect(pnpmCalls()).toBe('')
  })
})
