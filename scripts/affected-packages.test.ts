import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  findAffectedPackages,
  loadPackages,
  loadPathImports,
  partitionWorkspaceGlobs,
  readWorkspaceGlobs,
  relativeImportsIn,
} from './affected-packages.ts'
import type { Pkg } from './affected-packages.ts'

// scripts/ sits directly under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('affected-packages / pnpm-workspace.yaml reconciliation', () => {
  it('reads the workspace globs straight from pnpm-workspace.yaml', () => {
    const { positive, negative } = readWorkspaceGlobs(repoRoot)
    // These roots MUST come from the file, not a second hardcoded copy.
    expect(positive).toContain('apps/*')
    expect(positive).toContain('slices/**')
    // The nested node_modules exclusion is a negation, not a member glob.
    expect(negative).toContain('**/node_modules/**')
  })

  it('honors the !**/node_modules/** negation', () => {
    const packages = Effect.runSync(loadPackages(repoRoot))
    const nested = packages.filter((p) => p.relDir.split('/').includes('node_modules'))
    expect(nested).toEqual([])
  })

  it('partitions !-prefixed entries into negations, others into positives', () => {
    fc.assert(
      // A single `!` is pnpm's negation prefix; `!!`-prefixed entries aren't a
      // real workspace shape and would leave an inner `!` after one strip, so
      // exclude them from the inputs to keep the `!`-free invariant below.
      fc.property(fc.array(fc.string().filter((s) => !s.startsWith('!!'))), (entries) => {
        const { positive, negative } = partitionWorkspaceGlobs(entries)
        expect(positive).toEqual(entries.filter((e) => !e.startsWith('!')))
        expect(negative).toEqual(entries.filter((e) => e.startsWith('!')).map((e) => e.slice(1)))
        for (const n of negative) expect(n.startsWith('!')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('affected-packages / findAffectedPackages', () => {
  const pkg = (
    name: string,
    relDir: string,
    deps: readonly string[] = [],
    devDeps: readonly string[] = []
  ): Pkg => ({ name, relDir, deps: new Set(deps), devDeps: new Set(devDeps) })

  // a-core <- a-react <-(dev) x-web; x-test sits inside x-web's folder.
  const packages = [
    pkg('a-core', 'slices/a/a-core'),
    pkg('a-react', 'slices/a/a-react', ['a-core']),
    pkg('x-web', 'apps/x/x-web', [], ['a-react']),
    pkg('x-test', 'apps/x/x-web/test', ['x-web']),
    pkg('lone', 'global/lone'),
  ]

  it('reaches every package depending on a changed one, through dev-dependencies too', () => {
    const result = findAffectedPackages(['slices/a/a-core/src/index.ts'], packages)
    expect([...result.changed]).toEqual(['a-core'])
    expect([...result.affected].toSorted()).toEqual(['a-core', 'a-react', 'x-test', 'x-web'])
  })

  it('reaches no dependency of a changed package', () => {
    const result = findAffectedPackages(['apps/x/x-web/src/main.tsx'], packages)
    expect([...result.affected].toSorted()).toEqual(['x-test', 'x-web'])
  })

  it('credits a file to the innermost package holding it', () => {
    const result = findAffectedPackages(['apps/x/x-web/test/state.test.ts'], packages)
    expect([...result.changed]).toEqual(['x-test'])
  })

  it('sorts root config and package-less files apart from package changes', () => {
    const result = findAffectedPackages(
      [
        'pnpm-lock.yaml',
        'vite.config.ts',
        'docs/Testing/Testing Reference.md',
        '.github/workflows/ci-typescript.yml',
        'scripts/ci/test-shards.ts',
        'global/lone/package.json',
      ],
      packages
    )
    expect(result.rootConfigChanges).toEqual(['pnpm-lock.yaml', 'vite.config.ts'])
    expect(result.unownedChanges).toEqual([
      '.github/workflows/ci-typescript.yml',
      'docs/Testing/Testing Reference.md',
      'scripts/ci/test-shards.ts',
    ])
    expect([...result.affected]).toEqual(['lone'])
  })

  it('reaches a package importing a file out of a changed one by relative path', () => {
    // x-web reads a JSON file out of lone's folder; no manifest records it.
    const pathImports = new Map([['x-web', new Set(['lone'])]])
    const result = findAffectedPackages(['global/lone/shared.json'], packages, pathImports)
    expect([...result.affected].toSorted()).toEqual(['lone', 'x-test', 'x-web'])
  })

  it('affects a set closed under depending, containing every changed package', () => {
    const files = packages.map((p) => `${p.relDir}/src/file.ts`)
    fc.assert(
      fc.property(fc.subarray(files), (changedFiles) => {
        const { changed, affected } = findAffectedPackages(changedFiles, packages)
        for (const name of changed) expect(affected.has(name)).toBe(true)
        for (const p of packages) {
          const dependsOnAffected = [...p.deps, ...p.devDeps].some((dep) => affected.has(dep))
          if (dependsOnAffected) expect(affected.has(p.name)).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('affected-packages / path imports', () => {
  it('reads relative specifiers from imports, re-exports and requires, query stripped', () => {
    const source = [
      "import { a } from '../a.ts'",
      "export * from './b.ts'",
      "import launcherRs from '../../c.rs?raw'",
      "import './d.css'",
      "const e = await import('../e.ts')",
      "const f = require('./f.cjs')",
      "import { g } from 'effect'",
    ].join('\n')
    expect(relativeImportsIn(source)).toEqual([
      '../a.ts',
      './b.ts',
      '../../c.rs',
      './d.css',
      '../e.ts',
      './f.cjs',
    ])
  })

  it("finds the workspace's imports of tauri-shared-config.json out of host-app", () => {
    const packages = Effect.runSync(loadPackages(repoRoot))
    const pathImports = Effect.runSync(loadPathImports(repoRoot, packages))
    // launcher-web can't declare host-app (nothing outside apps/host may), yet
    // its tests read the shared config straight out of host-app's folder.
    expect(pathImports.get('@wildflowerhealthio/launcher-web')).toContain(
      '@wildflowerhealthio/host-app'
    )
  })
})
