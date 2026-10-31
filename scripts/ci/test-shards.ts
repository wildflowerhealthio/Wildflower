#!/usr/bin/env node
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Emits the GitHub Actions matrix ci-typescript.yml's `test` job fans out
// over: `{ include: [{ name, runs: [{ projects, vitestShard? }, ...] }, ...] }`,
// one entry per test shard. The workspace divides into top-level areas —
// `global`, `scripts`, `slices`, and each `apps/<folder>` — whose Vitest
// projects come from Vitest itself (the root vite.config.ts `test.projects`
// globs, each project named after its package), so a new app folder is a new
// area with no edit here, and a project nothing claims fails the plan instead
// of being dropped. Only the areas a branch's changes can affect run: see
// `selectionFor` for the rules. The selected areas are then packed by their
// rough test time onto at most `TEST_SHARD_COUNT` runners, each of which runs
// its projects, selected by name with `--project`: see `packUnits`.
import { Console, Effect, Either, Schema } from 'effect'
import { createVitest } from 'vite-plus/test/node'

import { loadAffectedPackages } from '../affected-packages.ts'
import type { AffectedPackages, Pkg } from '../affected-packages.ts'
import { isEntrypoint } from '../entrypoint.ts'

/** scripts/ci/ sits two levels under the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Top-level directories that are one shard each, whatever lies beneath. */
const WHOLE_DIRECTORY_AREAS: ReadonlySet<string> = new Set(['global', 'scripts', 'slices'])

/** The directory whose every child folder is its own area (`apps/<folder>`). */
const PER_FOLDER_AREA_PARENT = 'apps'

/**
 * Areas run on every branch, whatever it changes. `scripts` holds no package
 * but checks the whole repo — the package graph from every manifest, the
 * `numRunsFor` convention across every test file — so no package change can
 * be relied on to select it.
 */
const ALWAYS_RUN_AREAS: ReadonlySet<string> = new Set(['scripts'])

/**
 * Areas split into this many Vitest `--shard` parts, each part packed like
 * any other area. `slices` alone takes longer than an even share of every
 * area over {@link TEST_SHARD_COUNT} shards, so whole it would set the wall
 * time; split, the parts balance against the rest. Every other area runs
 * whole.
 */
const VITEST_PARTS_BY_AREA: ReadonlyMap<string, number> = new Map([['slices', 2]])

/**
 * The most runners the test job takes at once. Every runner pays about a
 * minute of fixed setup (Vite+, install, `vp run pack`) before any test, and
 * the account shares 20 concurrent runners across every workflow, so the
 * areas share a few runners rather than taking one each.
 */
const TEST_SHARD_COUNT = 4

/**
 * Rough seconds each area's `Run tests` step takes on a CI runner, the weights
 * the packing balances. Read off one full run's job logs in October 2026 and
 * rounded; they only need to rank the areas, so re-measure when the shards
 * drift well out of balance rather than on every change. A split area's time
 * is the whole area's, divided evenly among its parts.
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

/** The most area labels a shard's name lists before summarizing the rest. */
const SHARD_NAME_LABELS = 3

/** A Vitest project: its name (what `--project` matches) and where it lives. */
interface VitestProject {
  readonly name: string
  /** The project's root, relative to the repo root (`apps/relay/relay-react`). */
  readonly root: string
}

/**
 * One piece of work the packing places: a whole area, or one `--shard` part of
 * a split area.
 */
interface TestUnit {
  /** The area, with the part for a split one (`slices 1/2`). */
  readonly label: string
  /** Names of the area's Vitest projects, sorted. */
  readonly projects: readonly string[]
  /** Vitest's `--shard <index>/<count>`, set only on a part of a split area. */
  readonly vitestShard?: string
  /** The unit's rough test time, from {@link AREA_TEST_SECONDS}. */
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
   * whole areas, then one per split-area part, since `--shard` divides every
   * selected project's files and so can't share a run with other areas.
   */
  runs: Schema.Array(TestRun),
})
type TestShard = Schema.Schema.Type<typeof TestShard>

const TestMatrix = Schema.Struct({ include: Schema.Array(TestShard) })
const encodeTestMatrix = Schema.encodeSync(TestMatrix)

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

/** Which areas a branch's test run covers. */
type ShardSelection =
  /** Every area: the change can reach past what the package graph tracks. */
  | { readonly _tag: 'AllAreas'; readonly reason: string }
  /** The areas holding one of these package directories, plus {@link ALWAYS_RUN_AREAS}. */
  | { readonly _tag: 'AffectedAreas'; readonly packageDirs: readonly string[] }

const allAreas = (reason: string): ShardSelection => ({ _tag: 'AllAreas', reason })

/**
 * The areas a branch's changes select. Every area runs when a root config
 * file or lockfile changed, or when any changed file sits outside every
 * package: CI workflows and actions, this script and the graph code it reads,
 * docs, Rust crates — their reach isn't in the package graph, so the plan errs
 * toward running everything. Otherwise only the areas holding a package the
 * changes reach (the changed packages and everything depending on them), plus
 * {@link ALWAYS_RUN_AREAS}. Pure — exported for unit testing.
 */
const selectionFor = (affected: AffectedPackages, packages: readonly Pkg[]): ShardSelection => {
  const [rootConfigChange] = affected.rootConfigChanges
  if (rootConfigChange !== undefined) return allAreas(`root config changed: ${rootConfigChange}`)
  const [unownedChange] = affected.unownedChanges
  if (unownedChange !== undefined) {
    const more = affected.unownedChanges.length - 1
    return allAreas(
      `changed outside every package: ${unownedChange}${more > 0 ? ` and ${more} more` : ''}`
    )
  }
  return {
    _tag: 'AffectedAreas',
    packageDirs: packages.filter((p) => affected.affected.has(p.name)).map((p) => p.relDir),
  }
}

/** Whether `selection` covers `area`. Pure — exported for unit testing. */
const selectsArea = (selection: ShardSelection, area: string): boolean =>
  selection._tag === 'AllAreas' ||
  ALWAYS_RUN_AREAS.has(area) ||
  selection.packageDirs.some((dir) => dir === area || dir.startsWith(`${area}/`))

/** Rough seconds an area's tests take: {@link AREA_TEST_SECONDS}, else the default. */
const areaSeconds = (area: string): number =>
  AREA_TEST_SECONDS.get(area) ?? DEFAULT_AREA_TEST_SECONDS

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
 * A packed shard's matrix entry. Its whole areas share one run; each split
 * part gets a run of its own. The name numbers the shard and lists its first
 * few labels, heaviest first: `3/4: apps/strength, apps/synthetic-data,
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
 * Group projects into units by area, splitting each area listed in
 * {@link VITEST_PARTS_BY_AREA} into that many `--shard` parts, keep the areas
 * `selection` covers, and pack them onto at most `shardCount` shards. Every
 * project is checked for an area first, so a project no area claims fails the
 * plan even on a branch that wouldn't run it. The packing is deterministic,
 * so the matrix is stable across runs with the same selection. A split
 * area's parts land on separate shards whenever there are two or more; on one
 * shard they still run correctly, as separate runs. Pure — exported for unit
 * testing.
 */
const planShards = (
  projects: readonly VitestProject[],
  selection: ShardSelection,
  shardCount: number = TEST_SHARD_COUNT
): Either.Either<readonly TestShard[], UnassignedProjectsError> => {
  const projectsByArea = new Map<string, string[]>()
  const unassigned: string[] = []
  for (const project of projects) {
    Either.match(areaOf(project.root), {
      onLeft: (root) => unassigned.push(root),
      onRight: (area) => {
        const names = projectsByArea.get(area) ?? []
        names.push(project.name)
        projectsByArea.set(area, names)
      },
    })
  }
  if (unassigned.length > 0) {
    return Either.left(new UnassignedProjectsError({ roots: unassigned.toSorted() }))
  }
  const areas = [...projectsByArea.keys()].filter((area) => selectsArea(selection, area))
  const units = areas.flatMap((area): TestUnit[] => {
    const names = (projectsByArea.get(area) ?? []).toSorted()
    const parts = VITEST_PARTS_BY_AREA.get(area) ?? 1
    const seconds = areaSeconds(area) / parts
    if (parts === 1) return [{ label: area, projects: names, seconds }]
    return Array.from({ length: parts }, (_, i) => ({
      label: `${area} ${i + 1}/${parts}`,
      projects: names,
      vitestShard: `${i + 1}/${parts}`,
      seconds,
    }))
  })
  const bins = packUnits(units, shardCount)
  return Either.right(bins.map((bin, i) => shardOf(bin, i, bins.length)))
}

/**
 * Every Vitest project the root config defines, as Vitest itself resolves it
 * — the same globs, negations and package-name naming `vp test` uses, so the
 * names always match what `--project` accepts. Loads each project's config
 * but runs nothing.
 */
const loadVitestProjects = (repoRoot: string): Effect.Effect<readonly VitestProject[], Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => createVitest({ root: repoRoot, watch: false }),
      catch: (cause) => new Error('Vitest could not resolve the workspace projects', { cause }),
    }),
    (vitest) =>
      Effect.succeed(
        vitest.projects.map((project) => ({
          name: project.name,
          root: relative(repoRoot, project.config.root),
        }))
      ),
    (vitest) => Effect.promise(() => vitest.close())
  )

/** A run for the summary: `51 projects --shard 1/2`. */
const describeRun = (run: TestRun): string =>
  `${run.projects.length} projects${run.vitestShard === undefined ? '' : ` --shard ${run.vitestShard}`}`

const formatSummary = (selection: ShardSelection, shards: readonly TestShard[]): string =>
  [
    selection._tag === 'AllAreas'
      ? `test shards: ${shards.length}, for every area (${selection.reason})`
      : `test shards: ${shards.length}, for ${selection.packageDirs.length} affected packages`,
    ...shards.map((shard) => `  ${shard.name}: ${shard.runs.map(describeRun).join(', then ')}`),
  ].join('\n')

const main = Effect.gen(function* () {
  const projects = yield* loadVitestProjects(REPO_ROOT)
  const { packages, affectedPackages } = yield* loadAffectedPackages(REPO_ROOT)
  const selection = selectionFor(affectedPackages, packages)
  const shards = yield* planShards(projects, selection)
  yield* Console.error(formatSummary(selection, shards))
  yield* Console.log(JSON.stringify(encodeTestMatrix({ include: shards })))
})

if (isEntrypoint(import.meta.url)) await Effect.runPromise(Effect.orDie(main))

export type { ShardSelection, TestUnit, VitestProject }
export {
  allAreas,
  areaOf,
  loadVitestProjects,
  packUnits,
  planShards,
  selectionFor,
  selectsArea,
  TEST_SHARD_COUNT,
  UnassignedProjectsError,
}
