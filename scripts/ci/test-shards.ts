#!/usr/bin/env node
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Emits the plan ci-typescript.yml's `test` job runs, `{ matrix, runScale }`.
// `matrix` is the GitHub Actions matrix the job fans out over:
// `{ include: [{ name, runs: [{ projects, vitestShard? }, ...] }, ...] }`, one
// entry per test shard. `runScale` is the fast-check run scale every shard
// hands `numRunsFor` as FC_RUN_SCALE. The Vitest projects come from Vitest
// itself (the root vite.config.ts `test.projects` globs, each project named
// after its package), so a new package is covered with no edit here. Only the
// projects a branch's changes can affect run: see `selectionFor`. The selected
// projects are grouped by top-level area — `global`, `scripts`, `slices`, and
// each `apps/<folder>` — and the groups packed by their rough test time onto
// at most `TEST_SHARD_COUNT` runners, each of which runs its projects,
// selected by name with `--project`: see `planShards`. A project no area
// claims fails the plan instead of being dropped.
import { Console, Effect, Either, Schema } from 'effect'
import { createVitest } from 'vite-plus/test/node'

import { loadAffectedPackages } from '../affected-packages.ts'
import type { AffectedPackages, Pkg } from '../affected-packages.ts'
import { isEntrypoint } from '../entrypoint.ts'

/** scripts/ci/ sits two levels under the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Top-level directories that are one area each, whatever lies beneath. */
const WHOLE_DIRECTORY_AREAS: ReadonlySet<string> = new Set(['global', 'scripts', 'slices'])

/** The directory whose every child folder is its own area (`apps/<folder>`). */
const PER_FOLDER_AREA_PARENT = 'apps'

/**
 * Areas whose selected projects split into this many Vitest `--shard` parts
 * when, whole, they would set the wall time, each part packed like any other
 * group. All of `slices` outweighs every other area and an even share of them
 * all over {@link TEST_SHARD_COUNT} shards, and so does what a change to a
 * widely used slice package (`fhir-r4`, `shared-structures-core`) reaches;
 * split, the parts balance against the rest. Every other group runs whole.
 */
const VITEST_PARTS_BY_AREA: ReadonlyMap<string, number> = new Map([['slices', 2]])

/**
 * The most runners the test job takes at once. Every runner pays about a
 * minute of fixed setup (Vite+, install, `vp run pack`) before any test, and
 * the account shares 20 concurrent runners across every workflow, so the
 * groups share a few runners rather than taking one each.
 */
const TEST_SHARD_COUNT = 4

/**
 * Rough seconds each area's `Run tests` step takes on a CI runner when all of
 * its projects run, the weights the packing balances. Read off one full run's
 * job logs in October 2026 and rounded; they only need to rank the groups, so
 * re-measure when the shards drift well out of balance rather than on every
 * change. A project's share is its share of the area's test files (see
 * {@link projectSeconds}); a split area's time is divided evenly among its
 * parts.
 */
const AREA_TEST_SECONDS: ReadonlyMap<string, number> = new Map([
  ['apps/app-catalog', 4],
  ['apps/authorization', 6],
  ['apps/fhir-sync-pebble', 11],
  ['apps/host', 41],
  ['apps/importer-web', 11],
  ['apps/launcher', 44],
  ['apps/medications', 24],
  ['apps/ohif-viewer-web', 3],
  ['apps/plots', 18],
  ['apps/relay', 5],
  ['apps/server-docs-web', 2],
  ['apps/strength', 49],
  ['apps/synthetic-data', 43],
  ['apps/watch-lifts', 6],
  ['apps/wildflower-site', 9],
  ['global', 42],
  ['scripts', 48],
  ['slices', 165],
])

/** The weight of an area missing from {@link AREA_TEST_SECONDS}: about the median area's. */
const DEFAULT_AREA_TEST_SECONDS = 15

/** The run scale for a branch that changed a package or a root config file. */
const FULL_RUN_SCALE = 1

/**
 * The run scale for a branch whose changes reach no package: CI plumbing,
 * docs, these scripts. Every project runs, since what those files reach isn't
 * in the package graph, but no package's code changed, so each property runs
 * a fifth of its base count (`numRunsFor` floors it at 10).
 */
const REDUCED_RUN_SCALE = 0.2

/** The most group labels a shard's name lists before summarizing the rest. */
const SHARD_NAME_LABELS = 3

/** A Vitest project: its name (what `--project` matches), where it lives, and its size. */
interface VitestProject {
  readonly name: string
  /** The project's root, relative to the repo root (`apps/relay/relay-react`). */
  readonly root: string
  /** How many test files the project's own `include` globs match. */
  readonly testFileCount: number
}

/**
 * One piece of work the packing places: an area's selected projects, or one
 * `--shard` part of a split area.
 */
interface TestUnit {
  /**
   * The area (`apps/strength`), with the part for a split one (`slices 1/2`),
   * or the project count when only some of its projects run
   * (`slices (3 projects)`).
   */
  readonly label: string
  /** Names of the unit's Vitest projects, sorted. */
  readonly projects: readonly string[]
  /** Vitest's `--shard <index>/<count>`, set only on a part of a split area. */
  readonly vitestShard?: string
  /** The unit's rough test time: see {@link projectSeconds}. */
  readonly seconds: number
}

/** One `vp test run` invocation inside a shard. */
const TestRun = Schema.Struct({
  /** Names of the Vitest projects the run selects, each passed as `--project`. */
  projects: Schema.Array(Schema.String),
  /** Vitest's `--shard <index>/<count>`, set only on a part of a split area. */
  vitestShard: Schema.optional(Schema.String),
})
type TestRun = Schema.Schema.Type<typeof TestRun>

const TestShard = Schema.Struct({
  /** The shard's label, shown in the job name: `Test (<name>)`. */
  name: Schema.String,
  /**
   * The Vitest invocations the shard runs one after another: one for all its
   * unsplit groups, then one per split-area part, since `--shard` divides
   * every selected project's files and so can't share a run with other areas.
   */
  runs: Schema.Array(TestRun),
})
type TestShard = Schema.Schema.Type<typeof TestShard>

const TestPlan = Schema.Struct({
  /** The `test` job's matrix, one `include` entry per shard. */
  matrix: Schema.Struct({ include: Schema.Array(TestShard) }),
  /** The FC_RUN_SCALE every shard runs under: see {@link runScaleFor}. */
  runScale: Schema.Number,
})
const encodeTestPlan = Schema.encodeSync(TestPlan)

/**
 * The area a project root belongs to: `apps/<folder>` for anything under
 * `apps/`, the top-level directory for a {@link WHOLE_DIRECTORY_AREAS} one, or
 * `Left(root)` for a root no area claims. Pure — exported for unit testing.
 */
const areaOf = (root: string): Either.Either<string, string> => {
  const [top, folder] = root.split('/')
  if (top === PER_FOLDER_AREA_PARENT && folder !== undefined && folder.length > 0) {
    return Either.right(`${PER_FOLDER_AREA_PARENT}/${folder}`)
  }
  if (top !== undefined && WHOLE_DIRECTORY_AREAS.has(top)) return Either.right(top)
  return Either.left(root)
}

/** Projects whose root no area claims — the plan refuses to drop them. */
class UnassignedProjectsError extends Schema.TaggedError<UnassignedProjectsError>()(
  'UnassignedProjectsError',
  { roots: Schema.Array(Schema.String) }
) {
  get message(): string {
    return `No test shard claims these Vitest project roots: ${this.roots.join(', ')}. Add their top-level directory to WHOLE_DIRECTORY_AREAS in scripts/ci/test-shards.ts.`
  }
}

/** Which projects a branch's test run covers, and at what fast-check run scale. */
type TestSelection =
  /** Every project: the change can reach past what the package graph tracks. */
  | { readonly _tag: 'AllProjects'; readonly reason: string; readonly runScale: number }
  /**
   * Every project except those of the packages the changes can't reach, at
   * {@link FULL_RUN_SCALE}. A project outside every package (`scripts`, whose
   * tests check the whole repo) always runs: no package change can be relied
   * on to reach it.
   */
  | {
      readonly _tag: 'AffectedProjects'
      readonly affectedPackageDirs: readonly string[]
      readonly unaffectedPackageDirs: readonly string[]
    }

const allProjects = (reason: string, runScale: number = FULL_RUN_SCALE): TestSelection => ({
  _tag: 'AllProjects',
  reason,
  runScale,
})

/**
 * The projects a branch's changes select. Every project runs when a root
 * config file or lockfile changed, or when any changed file sits outside every
 * package: CI workflows and actions, these scripts and the graph code they
 * read, docs, Rust crates — their reach isn't in the package graph, so the
 * plan errs toward running everything. When those changes reach no package,
 * everything runs at {@link REDUCED_RUN_SCALE}; when a package changed too, at
 * full scale, so a changed package's properties never run reduced. Otherwise
 * only the projects of packages the changes reach (the changed packages and
 * everything depending on them) run, plus those outside every package. Pure —
 * exported for unit testing.
 */
const selectionFor = (affected: AffectedPackages, packages: readonly Pkg[]): TestSelection => {
  const [rootConfigChange] = affected.rootConfigChanges
  if (rootConfigChange !== undefined) return allProjects(`root config changed: ${rootConfigChange}`)
  const [unownedChange] = affected.unownedChanges
  if (unownedChange !== undefined) {
    const more = affected.unownedChanges.length - 1
    return allProjects(
      `changed outside every package: ${unownedChange}${more > 0 ? ` and ${more} more` : ''}`,
      affected.affected.size === 0 ? REDUCED_RUN_SCALE : FULL_RUN_SCALE
    )
  }
  return {
    _tag: 'AffectedProjects',
    affectedPackageDirs: packages.filter((p) => affected.affected.has(p.name)).map((p) => p.relDir),
    unaffectedPackageDirs: packages
      .filter((p) => !affected.affected.has(p.name))
      .map((p) => p.relDir),
  }
}

/** Whether `selection` covers `project`. Pure — exported for unit testing. */
const selectsProject = (selection: TestSelection, project: VitestProject): boolean =>
  selection._tag === 'AllProjects' || !selection.unaffectedPackageDirs.includes(project.root)

/** The FC_RUN_SCALE a selection runs at. Pure — exported for unit testing. */
const runScaleFor = (selection: TestSelection): number =>
  selection._tag === 'AllProjects' ? selection.runScale : FULL_RUN_SCALE

/**
 * Rough seconds a project's tests take: its area's {@link AREA_TEST_SECONDS}
 * (else {@link DEFAULT_AREA_TEST_SECONDS}), times the project's share of the
 * area's test files. An area whose projects match no test file shares its
 * time evenly.
 */
const projectSeconds = (
  project: VitestProject,
  area: string,
  areaProjects: readonly VitestProject[]
): number => {
  const areaSeconds = AREA_TEST_SECONDS.get(area) ?? DEFAULT_AREA_TEST_SECONDS
  const areaTestFiles = areaProjects.reduce((sum, p) => sum + p.testFileCount, 0)
  return areaTestFiles === 0
    ? areaSeconds / areaProjects.length
    : (areaSeconds * project.testFileCount) / areaTestFiles
}

/**
 * Pack units onto at most `shardCount` shards, balancing their summed
 * seconds: longest first, each onto the shard with the least so far (the
 * lowest-numbered on a tie). Fewer units than shards leaves one unit per
 * shard, never an empty shard. Each shard lists its units in the order they
 * were placed, heaviest first. Generic over anything with a label and
 * seconds, so pages-sites.ts packs its preview groups with it too. Pure —
 * exported for unit testing.
 */
const packUnits = <Unit extends Pick<TestUnit, 'label' | 'seconds'>>(
  units: readonly Unit[],
  shardCount: number
): readonly (readonly Unit[])[] => {
  const bins = Array.from({ length: Math.min(shardCount, units.length) }, () => ({
    seconds: 0,
    units: [] as Unit[],
  }))
  const longestFirst = units.toSorted(
    (a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label)
  )
  for (const unit of longestFirst) {
    const lightest = bins.reduce((min, bin) => (bin.seconds < min.seconds ? bin : min))
    lightest.seconds += unit.seconds
    lightest.units.push(unit)
  }
  return bins.map((bin) => bin.units)
}

/**
 * A packed shard's matrix entry. Its unsplit groups share one run; each split
 * part gets a run of its own. The name numbers the shard and lists its first
 * few labels, heaviest first: `3/4: apps/strength, slices (3 projects),
 * apps/medications +2 more`.
 */
const shardOf = (units: readonly TestUnit[], index: number, count: number): TestShard => {
  const whole = units.filter((unit) => unit.vitestShard === undefined)
  const split = units.filter((unit) => unit.vitestShard !== undefined)
  const runs: TestRun[] = [
    ...(whole.length > 0 ? [{ projects: whole.flatMap((unit) => unit.projects).toSorted() }] : []),
    ...split.map((unit) => ({ projects: unit.projects, vitestShard: unit.vitestShard })),
  ]
  const shown = units.slice(0, SHARD_NAME_LABELS).map((unit) => unit.label)
  const hidden = units.length - shown.length
  const labels = `${shown.join(', ')}${hidden > 0 ? ` +${hidden} more` : ''}`
  return { name: `${index + 1}/${count}: ${labels}`, runs }
}

/**
 * The group one area contributes: the projects `selection` covers that match
 * a test file (a run whose projects match none fails), or `undefined` when it
 * covers none. Labelled with the area, and with the project count when only
 * some of the area's projects run.
 */
const groupOf = (
  area: string,
  areaProjects: readonly VitestProject[],
  selection: TestSelection
): TestUnit | undefined => {
  const withTests = areaProjects.filter((project) => project.testFileCount > 0)
  const selected = withTests.filter((project) => selectsProject(selection, project))
  if (selected.length === 0) return undefined
  const seconds = selected.reduce(
    (sum, project) => sum + projectSeconds(project, area, areaProjects),
    0
  )
  const count = `${selected.length} project${selected.length === 1 ? '' : 's'}`
  return {
    label: selected.length < withTests.length ? `${area} (${count})` : area,
    projects: selected.map((project) => project.name).toSorted(),
    seconds,
  }
}

/**
 * `group` as `parts` `--shard` parts, each with an even share of its time, when
 * it outweighs `wallTimeFloor`; else `group` alone.
 */
const splitIfHeavy = (
  group: TestUnit,
  parts: number,
  wallTimeFloor: number
): readonly TestUnit[] =>
  parts > 1 && group.seconds > wallTimeFloor
    ? Array.from({ length: parts }, (_, i) => ({
        label: `${group.label} ${i + 1}/${parts}`,
        projects: group.projects,
        vitestShard: `${i + 1}/${parts}`,
        seconds: group.seconds / parts,
      }))
    : [group]

/**
 * Group the projects `selection` covers by area, split a group of an area in
 * {@link VITEST_PARTS_BY_AREA} that outweighs both every other group and an
 * even share of the plan over `shardCount` (whole, it would set the wall time)
 * into `--shard` parts, and pack the groups onto at most
 * `shardCount` shards. Every project is checked for an area first, so a
 * project no area claims fails the plan even on a branch that wouldn't run
 * it. The packing is deterministic, so the matrix is stable across runs with
 * the same selection. A split group's parts land on separate shards whenever
 * there are two or more; on one shard they still run correctly, as separate
 * runs. Pure — exported for unit testing.
 */
const planShards = (
  projects: readonly VitestProject[],
  selection: TestSelection,
  shardCount: number = TEST_SHARD_COUNT
): Either.Either<readonly TestShard[], UnassignedProjectsError> => {
  const projectsByArea = new Map<string, VitestProject[]>()
  const unassigned: string[] = []
  for (const project of projects) {
    Either.match(areaOf(project.root), {
      onLeft: (root) => unassigned.push(root),
      onRight: (area) => {
        const areaProjects = projectsByArea.get(area) ?? []
        areaProjects.push(project)
        projectsByArea.set(area, areaProjects)
      },
    })
  }
  if (unassigned.length > 0) {
    return Either.left(new UnassignedProjectsError({ roots: unassigned.toSorted() }))
  }
  const groups = [...projectsByArea].flatMap(([area, areaProjects]) => {
    const group = groupOf(area, areaProjects, selection)
    return group === undefined ? [] : [{ group, parts: VITEST_PARTS_BY_AREA.get(area) ?? 1 }]
  })
  const evenShare = groups.reduce((sum, { group }) => sum + group.seconds, 0) / shardCount
  const units = groups.flatMap(({ group, parts }) => {
    const heaviestOther = Math.max(
      0,
      ...groups.filter((other) => other.group !== group).map((other) => other.group.seconds)
    )
    return splitIfHeavy(group, parts, Math.max(evenShare, heaviestOther))
  })
  const bins = packUnits(units, shardCount)
  return Either.right(bins.map((bin, i) => shardOf(bin, i, bins.length)))
}

/**
 * Every Vitest project the root config defines, as Vitest itself resolves it
 * — the same globs, negations and package-name naming `vp test` uses, so the
 * names always match what `--project` accepts — with how many test files its
 * own `include` globs match. Loads each project's config but runs nothing.
 */
const loadVitestProjects = (repoRoot: string): Effect.Effect<readonly VitestProject[], Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => createVitest({ root: repoRoot, watch: false }),
      catch: (cause) => new Error('Vitest could not resolve the workspace projects', { cause }),
    }),
    (vitest) =>
      Effect.forEach(vitest.projects, (project) =>
        Effect.tryPromise({
          try: () => project.globTestFiles(),
          catch: (cause) =>
            new Error(`Vitest could not list the test files of ${project.name}`, { cause }),
        }).pipe(
          Effect.map(({ testFiles }) => ({
            name: project.name,
            root: relative(repoRoot, project.config.root),
            testFileCount: testFiles.length,
          }))
        )
      ),
    (vitest) => Effect.promise(() => vitest.close())
  )

/** A run for the summary: `51 projects --shard 1/2`. */
const describeRun = (run: TestRun): string =>
  `${run.projects.length} project${run.projects.length === 1 ? '' : 's'}${run.vitestShard === undefined ? '' : ` --shard ${run.vitestShard}`}`

const formatSummary = (selection: TestSelection, shards: readonly TestShard[]): string =>
  [
    selection._tag === 'AllProjects'
      ? `test shards: ${shards.length}, for every project at run scale ${selection.runScale} (${selection.reason})`
      : `test shards: ${shards.length}, for ${selection.affectedPackageDirs.length} affected packages`,
    ...shards.map((shard) => `  ${shard.name}: ${shard.runs.map(describeRun).join(', then ')}`),
  ].join('\n')

const main = Effect.gen(function* () {
  const projects = yield* loadVitestProjects(REPO_ROOT)
  const { packages, affectedPackages } = yield* loadAffectedPackages(REPO_ROOT)
  const selection = selectionFor(affectedPackages, packages)
  const shards = yield* planShards(projects, selection)
  yield* Console.error(formatSummary(selection, shards))
  yield* Console.log(
    JSON.stringify(
      encodeTestPlan({ matrix: { include: shards }, runScale: runScaleFor(selection) })
    )
  )
})

if (isEntrypoint(import.meta.url)) await Effect.runPromise(Effect.orDie(main))

export type { TestSelection, TestUnit, VitestProject }
export {
  allProjects,
  areaOf,
  loadVitestProjects,
  packUnits,
  planShards,
  REDUCED_RUN_SCALE,
  runScaleFor,
  selectionFor,
  selectsProject,
  TEST_SHARD_COUNT,
  UnassignedProjectsError,
}
