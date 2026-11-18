import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const scriptPath = join(repoRoot, '.devcontainer', 'global-tool-specs.sh')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'global-tool-specs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lockfile = (contents: string): string => {
  const path = join(dir, 'pnpm-lock.yaml')
  writeFileSync(path, contents)
  return path
}

const run = (
  ...args: ReadonlyArray<string>
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8' })
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

describe('global-tool-specs.sh', () => {
  it('prints each tool at the version the lockfile resolves, not the catalog range', () => {
    const path = lockfile(
      [
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
      ].join('\n')
    )

    expect(run(path)).toEqual({
      status: 0,
      stdout: 'vite-plus@1.6.0 typescript@7.0.2 @tsdown/css@0.23.9\n',
      stderr: '',
    })
  })

  it('matches the catalog versions in the repository lockfile', () => {
    const versions = Schema.decodeUnknownSync(CatalogVersions)(
      parse(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'))
    ).catalogs.default

    expect(run().stdout).toBe(
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

    const result = run(path)

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no resolved version for catalog entry typescript-7')
  })

  it('fails when there is no lockfile at the path', () => {
    const result = run(join(dir, 'missing.yaml'))

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no lockfile at')
  })
})
