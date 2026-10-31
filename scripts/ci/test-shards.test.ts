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
  allProjects,
  areaOf,
  loadVitestProjects,
  packUnits,
  planShards,
  REDUCED_RUN_SCALE,
  runScaleFor,
  selectionFor,
  TEST_SHARD_COUNT,
} from './test-shards.ts'
import type { TestSelection, TestUnit, VitestProject } from './test-shards.ts'

// scripts/ci/ sits two levels under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A project root path segment: what a workspace folder name looks like. */
const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/)

const projectUnder = (top: fc.Arbitrary<string>): fc.Arbitrary<VitestProject> =>
  fc
    .tuple(
      top,
      fc.array(segment, { minLength: 1, maxLength: 4 }),
      segment,
      fc.integer({ min: 1, max: 60 })
    )
    .map(([head, rest, name, testFileCount]) => ({
      name: `${head}-${rest.join('-')}-${name}`,
      root: [head, ...rest].join('/'),
      testFileCount,
    }))

/** A project at `root` named after its last segment, with `testFileCount` test files. */
const projectAt = (root: string, testFileCount = 1): VitestProject => ({
  name: root.split('/').at(-1) ?? root,
  root,
  testFileCount,
})

const everyProject = allProjects('every project, under test')

const claimedTop = fc.constantFrom('apps', 'global', 'scripts', 'slices')

interface PlannedShard {
  readonly name: string
  readonly runs: readonly {
    readonly projects: readonly string[]
    readonly vitestShard?: string | undefined
  }[]
}

/**
 * The project names `shards` cover, once each: unsplit runs list theirs
 * directly, and a split group's parts all list the same projects, counted once.
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
          const shards = Either.getOrThrow(planShards(projects, everyProject))
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
      [projectAt('apps/relay/relay-core-js'), projectAt('tools/stray')],
      // Even a branch that selects no project must not hide the stray one.
      { _tag: 'AffectedProjects', affectedPackageDirs: [], unaffectedPackageDirs: [] }
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.roots).toEqual(['tools/stray'])
  })

  it('runs each slices part on its own shard, in a run of its own', () => {
    const projects = [
      { name: 'b', root: 'slices/fhir/fhir-r4', testFileCount: 1 },
      { name: 'a', root: 'slices/dicom/dicom', testFileCount: 1 },
      { name: 'scripts', root: 'scripts', testFileCount: 1 },
      { name: 'relay', root: 'apps/relay/relay-react', testFileCount: 1 },
    ]
    expect(Either.getOrThrow(planShards(projects, everyProject, 3))).toEqual([
      { name: '1/3: slices 1/2', runs: [{ projects: ['a', 'b'], vitestShard: '1/2' }] },
      { name: '2/3: slices 2/2', runs: [{ projects: ['a', 'b'], vitestShard: '2/2' }] },
      { name: '3/3: scripts, apps/relay', runs: [{ projects: ['relay', 'scripts'] }] },
    ])
  })

  it('runs a part beside whole areas as a separate run', () => {
    const projects = [
      { name: 'fhir', root: 'slices/fhir/fhir-r4', testFileCount: 1 },
      { name: 'scripts', root: 'scripts', testFileCount: 1 },
      { name: 'kitchen-sink', root: 'global/kitchen-sink', testFileCount: 1 },
    ]
    expect(Either.getOrThrow(planShards(projects, everyProject, 2))).toEqual([
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
    const projects = ['a', 'b', 'c', 'd', 'e'].map((folder) =>
      projectAt(`apps/${folder}/${folder}-web`)
    )
    const [shard] = Either.getOrThrow(planShards(projects, everyProject, 1))
    expect(shard?.name).toBe('1/1: apps/a, apps/b, apps/c +2 more')
  })

  it("runs only an area's selected projects, labelled with their count", () => {
    const projects = [
      projectAt('apps/strength/strength-core-js'),
      projectAt('apps/strength/strength-react'),
      projectAt('apps/strength/strength-web'),
    ]
    const selection = {
      _tag: 'AffectedProjects',
      affectedPackageDirs: ['apps/strength/strength-web'],
      unaffectedPackageDirs: ['apps/strength/strength-core-js', 'apps/strength/strength-react'],
    } as const
    expect(Either.getOrThrow(planShards(projects, selection))).toEqual([
      { name: '1/1: apps/strength (1 project)', runs: [{ projects: ['strength-web'] }] },
    ])
  })

  it('leaves out a project with no test files, which Vitest would fail on', () => {
    const projects = [
      projectAt('apps/relay/relay-admin-web', 0),
      projectAt('apps/relay/relay-react', 1),
      projectAt('apps/ohif-viewer-web', 0),
    ]
    // The area still reads as whole: every project with a test file runs.
    expect(Either.getOrThrow(planShards(projects, everyProject))).toEqual([
      { name: '1/1: apps/relay', runs: [{ projects: ['relay-react'] }] },
    ])
  })

  it('splits a slices group only when, whole, it would set the wall time', () => {
    // `slices` weighs 165s, shared by test file: fhir-r4 holds 9 of its 10.
    const projects = [
      projectAt('slices/fhir/fhir-r4', 9),
      projectAt('slices/file-formats/dicom', 1),
      projectAt('scripts', 1),
    ]
    const changing = (packageDir: string, otherDir: string) =>
      ({
        _tag: 'AffectedProjects',
        affectedPackageDirs: [packageDir],
        unaffectedPackageDirs: [otherDir],
      }) as const
    // dicom: 16.5s, lighter than scripts' 48s, runs whole.
    expect(
      Either.getOrThrow(
        planShards(projects, changing('slices/file-formats/dicom', 'slices/fhir/fhir-r4'))
      )
    ).toEqual([
      { name: '1/2: scripts', runs: [{ projects: ['scripts'] }] },
      { name: '2/2: slices (1 project)', runs: [{ projects: ['dicom'] }] },
    ])
    // fhir-r4: 148.5s, heavier than scripts and an even share (196.5s / 4), splits.
    expect(
      Either.getOrThrow(
        planShards(projects, changing('slices/fhir/fhir-r4', 'slices/file-formats/dicom'))
      )
    ).toEqual([
      {
        name: '1/3: slices (1 project) 1/2',
        runs: [{ projects: ['fhir-r4'], vitestShard: '1/2' }],
      },
      {
        name: '2/3: slices (1 project) 2/2',
        runs: [{ projects: ['fhir-r4'], vitestShard: '2/2' }],
      },
      { name: '3/3: scripts', runs: [{ projects: ['scripts'] }] },
    ])
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
    const shards = Either.getOrThrow(planShards(projects, everyProject))
    const names = projects.filter((p) => p.testFileCount > 0).map((p) => p.name)
    // Every project with a test file run once, none dropped, none invented.
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

  // A slice package two apps build on, a slice package nothing here uses, an
  // app nothing depends on, and a global package.
  const packages = [
    pkg('fhir-r4', 'slices/fhir/fhir-r4'),
    pkg('dicom', 'slices/file-formats/dicom'),
    pkg('strength-web', 'apps/strength/strength-web', ['fhir-r4']),
    pkg('launcher-web', 'apps/launcher/launcher-web', ['fhir-r4']),
    pkg('relay-react', 'apps/relay/relay-react'),
    pkg('kitchen-sink', 'global/kitchen-sink'),
  ]
  const projects = [...packages.map((p) => projectAt(p.relDir)), projectAt('scripts')]

  const selectionAfter = (changedFiles: readonly string[]): TestSelection =>
    selectionFor(findAffectedPackages(changedFiles, packages), packages)

  /** The projects the plan runs for `changedFiles`, sorted. */
  const projectsFor = (changedFiles: readonly string[]): readonly string[] =>
    projectsCovered(
      Either.getOrThrow(planShards(projects, selectionAfter(changedFiles)))
    ).toSorted()

  const allProjectNames = projects.map((p) => p.name).toSorted()

  it("runs a changed package's project, its dependers' projects, and scripts", () => {
    expect(projectsFor(['slices/fhir/fhir-r4/src/index.ts'])).toEqual([
      'fhir-r4',
      'launcher-web',
      'scripts',
      'strength-web',
    ])
    expect(runScaleFor(selectionAfter(['slices/fhir/fhir-r4/src/index.ts']))).toBe(1)
  })

  it('runs only the changed app and scripts when nothing depends on it', () => {
    expect(projectsFor(['apps/relay/relay-react/src/screen.tsx'])).toEqual([
      'relay-react',
      'scripts',
    ])
  })

  it('runs every project at full scale for a root config or lockfile change', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'vite.config.base.ts',
      'dev-app-ports.json',
      'package.json',
    ]) {
      expect(projectsFor([file])).toEqual(allProjectNames)
      expect(runScaleFor(selectionAfter([file]))).toBe(1)
    }
  })

  const outsideEveryPackage = [
    '.github/workflows/ci-typescript.yml',
    '.github/actions/vp-pack-cache/action.yml',
    'scripts/ci/test-shards.ts',
    'scripts/affected-packages.ts',
    'slices/fhir/fhir-rust/src/lib.rs',
    'Cargo.toml',
  ]

  const markdownOutsideEveryPackage = [
    'docs/Testing/Testing Reference.md',
    'AGENTS.md',
    'slices/fhir/fhir-rust/README.md',
  ]

  it('runs every project at the reduced scale for changes that reach no package', () => {
    for (const file of outsideEveryPackage) {
      expect(projectsFor([file])).toEqual(allProjectNames)
      expect(runScaleFor(selectionAfter([file]))).toBe(REDUCED_RUN_SCALE)
    }
  })

  it('runs every project at full scale for changes outside and inside packages', () => {
    for (const file of outsideEveryPackage) {
      const changes = [file, 'apps/relay/relay-react/src/screen.tsx']
      expect(projectsFor(changes)).toEqual(allProjectNames)
      expect(runScaleFor(selectionAfter(changes))).toBe(1)
    }
  })

  it('runs only the projects outside every package when the changes reach none', () => {
    expect(projectsFor([])).toEqual(['scripts'])
  })

  it('selects nothing for Markdown outside every package', () => {
    for (const file of markdownOutsideEveryPackage) {
      expect(projectsFor([file])).toEqual(['scripts'])
      expect(runScaleFor(selectionAfter([file]))).toBe(1)
      const withApp = [file, 'apps/relay/relay-react/src/screen.tsx']
      expect(projectsFor(withApp)).toEqual(['relay-react', 'scripts'])
      expect(runScaleFor(selectionAfter(withApp))).toBe(1)
    }
  })

  it('still runs every project for Markdown beside another change outside every package', () => {
    const changes = ['docs/CI/Required Check Explanation.md', '.github/workflows/ci.yml']
    expect(projectsFor(changes)).toEqual(allProjectNames)
    expect(runScaleFor(selectionAfter(changes))).toBe(REDUCED_RUN_SCALE)
  })
})

describe('test-shards / example plans', () => {
  // A slice of the real workspace, with its test file counts: `slices` weighs
  // 165s in all, `scripts` 48s, `apps/strength` 49s, `apps/launcher` 44s.
  const packages: readonly Pkg[] = [
    { name: 'fhir-r4', relDir: 'slices/fhir/fhir-r4', deps: new Set(), devDeps: new Set() },
    { name: 'dicom', relDir: 'slices/file-formats/dicom', deps: new Set(), devDeps: new Set() },
    {
      name: 'strength-web',
      relDir: 'apps/strength/strength-web',
      deps: new Set(['fhir-r4']),
      devDeps: new Set(),
    },
    {
      name: 'strength-core-js',
      relDir: 'apps/strength/strength-core-js',
      deps: new Set(),
      devDeps: new Set(),
    },
    {
      name: 'launcher-web',
      relDir: 'apps/launcher/launcher-web',
      deps: new Set(['fhir-r4']),
      devDeps: new Set(),
    },
  ]
  const projects = [
    projectAt('slices/fhir/fhir-r4', 58),
    projectAt('slices/file-formats/dicom', 9),
    projectAt('apps/strength/strength-web', 15),
    projectAt('apps/strength/strength-core-js', 14),
    projectAt('apps/launcher/launcher-web', 27),
    projectAt('scripts', 22),
  ]

  const planFor = (
    changedFiles: readonly string[]
  ): { readonly shards: readonly PlannedShard[]; readonly runScale: number } => {
    const selection = selectionFor(findAffectedPackages(changedFiles, packages), packages)
    return {
      shards: Either.getOrThrow(planShards(projects, selection)),
      runScale: runScaleFor(selection),
    }
  }

  it('a change to one slice package runs it, its dependers and scripts', () => {
    // fhir-r4 holds 58 of the 67 slices test files here: about 143s, heavier
    // than every other group and an even share of the plan, so it splits.
    expect(planFor(['slices/fhir/fhir-r4/src/index.ts'])).toEqual({
      shards: [
        {
          name: '1/4: slices (1 project) 1/2',
          runs: [{ projects: ['fhir-r4'], vitestShard: '1/2' }],
        },
        {
          name: '2/4: slices (1 project) 2/2',
          runs: [{ projects: ['fhir-r4'], vitestShard: '2/2' }],
        },
        { name: '3/4: scripts', runs: [{ projects: ['scripts'] }] },
        {
          name: '4/4: apps/launcher, apps/strength (1 project)',
          runs: [{ projects: ['launcher-web', 'strength-web'] }],
        },
      ],
      runScale: 1,
    })
  })

  it('a change to one app runs that app and scripts', () => {
    expect(planFor(['apps/strength/strength-core-js/src/plan.ts'])).toEqual({
      shards: [
        { name: '1/2: scripts', runs: [{ projects: ['scripts'] }] },
        { name: '2/2: apps/strength (1 project)', runs: [{ projects: ['strength-core-js'] }] },
      ],
      runScale: 1,
    })
  })

  it('a docs-only change runs only scripts', () => {
    expect(planFor(['docs/Testing/Testing Reference.md'])).toEqual({
      shards: [{ name: '1/1: scripts', runs: [{ projects: ['scripts'] }] }],
      runScale: 1,
    })
  })

  it('a docs and app change runs that app and scripts', () => {
    expect(
      planFor(['docs/Testing/Testing Reference.md', 'apps/strength/strength-core-js/src/plan.ts'])
    ).toEqual({
      shards: [
        { name: '1/2: scripts', runs: [{ projects: ['scripts'] }] },
        { name: '2/2: apps/strength (1 project)', runs: [{ projects: ['strength-core-js'] }] },
      ],
      runScale: 1,
    })
  })

  it('a CI-only change runs everything at the reduced scale', () => {
    const { shards, runScale } = planFor(['.github/workflows/ci-typescript.yml'])
    expect(projectsCovered(shards).toSorted()).toEqual(projects.map((p) => p.name).toSorted())
    expect(shards.map((shard) => shard.name)).toEqual([
      '1/4: slices 1/2',
      '2/4: slices 2/2',
      '3/4: apps/strength',
      '4/4: scripts, apps/launcher',
    ])
    expect(runScale).toBe(REDUCED_RUN_SCALE)
  })

  it('a lockfile change runs everything at full scale', () => {
    const { shards, runScale } = planFor(['pnpm-lock.yaml'])
    expect(projectsCovered(shards).toSorted()).toEqual(projects.map((p) => p.name).toSorted())
    expect(runScale).toBe(1)
  })
})
