import { globSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { findAffectedPackages } from '../affected-packages.ts'
import type { Pkg } from '../affected-packages.ts'
import {
  allAreas,
  areaOf,
  loadVitestProjects,
  packUnits,
  planShards,
  selectionFor,
  TEST_SHARD_COUNT,
} from './test-shards.ts'
import type { TestUnit, VitestProject } from './test-shards.ts'

// scripts/ci/ sits two levels under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A project root path segment: what a workspace folder name looks like. */
const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/)

const projectUnder = (top: fc.Arbitrary<string>): fc.Arbitrary<VitestProject> =>
  fc
    .tuple(top, fc.array(segment, { minLength: 1, maxLength: 4 }), segment)
    .map(([head, rest, name]) => ({
      name: `${head}-${rest.join('-')}-${name}`,
      root: [head, ...rest].join('/'),
    }))

const everyArea = allAreas('every area, under test')

const claimedTop = fc.constantFrom('apps', 'global', 'scripts', 'slices')

interface PlannedShard {
  readonly name: string
  readonly runs: readonly {
    readonly projects: readonly string[]
    readonly vitestShard?: string | undefined
  }[]
}

/**
 * The project names `shards` cover, once each: whole-area runs list theirs
 * directly, and a split area's parts all list the same projects, counted once.
 */
const projectsCovered = (shards: readonly PlannedShard[]): readonly string[] => {
  const runs = shards.flatMap((shard) => shard.runs)
  const whole = runs.filter((run) => run.vitestShard === undefined).flatMap((run) => run.projects)
  const split = new Set(
    runs.filter((run) => run.vitestShard !== undefined).flatMap((run) => run.projects)
  )
  return [...whole, ...split]
}

/** Every `--shard` part the plan runs, across all shards. */
const vitestShardsRun = (shards: readonly PlannedShard[]): readonly string[] =>
  shards.flatMap((shard) => shard.runs.flatMap((run) => run.vitestShard ?? []))

describe('test-shards / areaOf', () => {
  it('gives every apps/<folder> descendant that folder as its area', () => {
    fc.assert(
      fc.property(segment, fc.array(segment, { maxLength: 4 }), (folder, rest) => {
        expect(areaOf(['apps', folder, ...rest].join('/'))).toEqual(Either.right(`apps/${folder}`))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('gives every global/scripts/slices descendant its top-level directory', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('global', 'scripts', 'slices'),
        fc.array(segment, { maxLength: 4 }),
        (top, rest) => {
          expect(areaOf([top, ...rest].join('/'))).toEqual(Either.right(top))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('claims no root outside those directories, nor bare apps/', () => {
    const unclaimedTop = segment.filter((s) => !['apps', 'global', 'scripts', 'slices'].includes(s))
    fc.assert(
      fc.property(unclaimedTop, fc.array(segment, { maxLength: 4 }), (top, rest) => {
        const root = [top, ...rest].join('/')
        expect(areaOf(root)).toEqual(Either.left(root))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
    expect(areaOf('apps')).toEqual(Either.left('apps'))
    expect(areaOf('')).toEqual(Either.left(''))
  })
})

describe('test-shards / planShards', () => {
  it('runs every claimed project exactly once, on at most TEST_SHARD_COUNT shards', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(projectUnder(claimedTop), { selector: (p) => p.name, maxLength: 30 }),
        (projects) => {
          const shards = Either.getOrThrow(planShards(projects, everyArea))
          expect(projectsCovered(shards).toSorted()).toEqual(projects.map((p) => p.name).toSorted())
          expect(shards.length).toBeLessThanOrEqual(TEST_SHARD_COUNT)
          for (const shard of shards) expect(shard.runs.length).toBeGreaterThan(0)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('fails on, rather than drops, a project no area claims', () => {
    const result = planShards(
      [
        { name: 'kept', root: 'apps/relay/relay-core-js' },
        { name: 'stray', root: 'tools/stray' },
      ],
      // Even a branch that selects no area must not hide the stray project.
      { _tag: 'AffectedAreas', packageDirs: [] }
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.roots).toEqual(['tools/stray'])
  })

  it('runs each slices part on its own shard, in a run of its own', () => {
    const projects = [
      { name: 'b', root: 'slices/fhir/fhir-r4' },
      { name: 'a', root: 'slices/dicom/dicom' },
      { name: 'scripts', root: 'scripts' },
      { name: 'relay', root: 'apps/relay/relay-react' },
    ]
    expect(Either.getOrThrow(planShards(projects, everyArea, 3))).toEqual([
      { name: '1/3: slices 1/2', runs: [{ projects: ['a', 'b'], vitestShard: '1/2' }] },
      { name: '2/3: slices 2/2', runs: [{ projects: ['a', 'b'], vitestShard: '2/2' }] },
      { name: '3/3: scripts, apps/relay', runs: [{ projects: ['relay', 'scripts'] }] },
    ])
  })

  it('runs a part beside whole areas as a separate run', () => {
    const projects = [
      { name: 'fhir', root: 'slices/fhir/fhir-r4' },
      { name: 'scripts', root: 'scripts' },
      { name: 'kitchen-sink', root: 'global/kitchen-sink' },
    ]
    expect(Either.getOrThrow(planShards(projects, everyArea, 2))).toEqual([
      {
        name: '1/2: slices 1/2, scripts',
        runs: [{ projects: ['scripts'] }, { projects: ['fhir'], vitestShard: '1/2' }],
      },
      {
        name: '2/2: slices 2/2, global',
        runs: [{ projects: ['kitchen-sink'] }, { projects: ['fhir'], vitestShard: '2/2' }],
      },
    ])
  })

  it('lists three areas in a shard name and counts the rest', () => {
    const projects = ['a', 'b', 'c', 'd', 'e'].map((folder) => ({
      name: folder,
      root: `apps/${folder}/${folder}-web`,
    }))
    const [shard] = Either.getOrThrow(planShards(projects, everyArea, 1))
    expect(shard?.name).toBe('1/1: apps/a, apps/b, apps/c +2 more')
  })
})

describe('test-shards / packUnits', () => {
  const unit = (label: string, seconds: number): TestUnit => ({ label, projects: [label], seconds })
  const labelsOf = (bins: readonly (readonly TestUnit[])[]): readonly (readonly string[])[] =>
    bins.map((bin) => bin.map((u) => u.label))

  it('places longest first onto the lightest shard', () => {
    const units = [unit('a', 10), unit('b', 50), unit('c', 30), unit('d', 25), unit('e', 20)]
    // b, c and d open the three shards; e joins d (25), the lightest, then a
    // joins c (30).
    expect(labelsOf(packUnits(units, 3))).toEqual([['b'], ['c', 'a'], ['d', 'e']])
  })

  it('makes one shard per unit when there are fewer units than shards', () => {
    expect(labelsOf(packUnits([unit('a', 1), unit('b', 2)], 4))).toEqual([['b'], ['a']])
    expect(packUnits([], 4)).toEqual([])
  })

  it('places every unit once, on at most the shard count, none empty', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(segment, fc.integer({ min: 1, max: 200 })), {
          selector: ([label]) => label,
          maxLength: 30,
        }),
        fc.integer({ min: 1, max: 8 }),
        (entries, shardCount) => {
          const units = entries.map(([label, seconds]) => unit(label, seconds))
          const bins = packUnits(units, shardCount)
          expect(bins.length).toBe(Math.min(shardCount, units.length))
          for (const bin of bins) expect(bin.length).toBeGreaterThan(0)
          expect(
            bins
              .flat()
              .map((u) => u.label)
              .toSorted()
          ).toEqual(units.map((u) => u.label).toSorted())
          // Longest-first greedy: no shard exceeds the lightest by more than
          // its own smallest unit, or it would have gone elsewhere.
          const loads = bins.map((bin) => bin.reduce((sum, u) => sum + u.seconds, 0))
          const lightest = Math.min(...loads)
          bins.forEach((bin, i) => {
            const smallest = Math.min(...bin.map((u) => u.seconds))
            expect((loads[i] ?? 0) - smallest).toBeLessThanOrEqual(lightest)
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('test-shards / the workspace', () => {
  it('partitions every real Vitest project into the shards', async () => {
    const projects = await Effect.runPromise(loadVitestProjects(repoRoot))
    const shards = Either.getOrThrow(planShards(projects, everyArea))
    const names = projects.map((p) => p.name)
    // Every project run once, none dropped, none invented.
    expect(projectsCovered(shards).toSorted()).toEqual(names.toSorted())
    expect(shards).toHaveLength(TEST_SHARD_COUNT)
    expect(vitestShardsRun(shards).toSorted()).toEqual(['1/2', '2/2'])
  }, 60_000)

  it('puts every test file in the repo under some Vitest project', async () => {
    const projects = await Effect.runPromise(loadVitestProjects(repoRoot))
    const testFiles = globSync('**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}', {
      cwd: repoRoot,
      exclude: (path) => /(^|\/)(node_modules|dist|target)$/.test(path),
    })
    // A package missing from the root `test.projects` list never runs.
    const unowned = testFiles.filter(
      (file) => !projects.some((project) => file.startsWith(`${project.root}/`))
    )
    expect(unowned).toEqual([])
  }, 60_000)
})

describe('test-shards / selectionFor', () => {
  const pkg = (name: string, relDir: string, deps: readonly string[] = []): Pkg => ({
    name,
    relDir,
    deps: new Set(deps),
    devDeps: new Set(),
  })

  // A slice package two apps build on, and an app nothing depends on.
  const packages = [
    pkg('fhir-r4', 'slices/fhir/fhir-r4'),
    pkg('strength-web', 'apps/strength/strength-web', ['fhir-r4']),
    pkg('launcher-web', 'apps/launcher/launcher-web', ['fhir-r4']),
    pkg('relay-react', 'apps/relay/relay-react'),
    pkg('kitchen-sink', 'global/kitchen-sink'),
  ]
  const projects = [
    ...packages.map((p) => ({ name: p.name, root: p.relDir })),
    { name: 'scripts', root: 'scripts' },
  ]

  const areaByProject = new Map(
    projects.map((p) => [p.name, Either.getOrThrow(areaOf(p.root))] as const)
  )

  /** The areas the plan runs for `changedFiles`, sorted. */
  const areasFor = (changedFiles: readonly string[]): readonly string[] => {
    const shards = Either.getOrThrow(
      planShards(projects, selectionFor(findAffectedPackages(changedFiles, packages), packages))
    )
    const areas = projectsCovered(shards).map((name) => areaByProject.get(name) ?? name)
    return [...new Set(areas)].toSorted()
  }

  const allAreaNames = [
    'apps/launcher',
    'apps/relay',
    'apps/strength',
    'global',
    'scripts',
    'slices',
  ]

  it("runs a changed package's area, its dependers' areas, and scripts", () => {
    expect(areasFor(['slices/fhir/fhir-r4/src/index.ts'])).toEqual([
      'apps/launcher',
      'apps/strength',
      'scripts',
      'slices',
    ])
  })

  it('runs only the changed app and scripts when nothing depends on it', () => {
    expect(areasFor(['apps/relay/relay-react/src/screen.tsx'])).toEqual(['apps/relay', 'scripts'])
  })

  it('runs every area for a root config or lockfile change', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'vite.config.base.ts',
      'package.json',
    ]) {
      expect(areasFor([file, 'apps/relay/relay-react/src/screen.tsx'])).toEqual(allAreaNames)
    }
  })

  it('runs every area for a change outside every package', () => {
    for (const file of [
      '.github/workflows/ci-typescript.yml',
      '.github/actions/vp-pack-cache/action.yml',
      'scripts/ci/test-shards.ts',
      'scripts/affected-packages.ts',
      'docs/Testing/Testing Reference.md',
      'slices/fhir/fhir-rust/src/lib.rs',
    ]) {
      expect(areasFor([file, 'apps/relay/relay-react/src/screen.tsx'])).toEqual(allAreaNames)
    }
  })

  it('runs only the always-run areas when the changes reach no package with tests', () => {
    expect(areasFor([])).toEqual(['scripts'])
  })
})
