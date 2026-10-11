#!/usr/bin/env node
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Emits the GitHub Actions matrix ci-typescript.yml's `test` job fans out
// over: `{ include: [{ name, projects, vitestShard? }, ...] }`, one entry per
// test shard. A shard is one top-level area of the workspace — `global`,
// `scripts`, `slices`, or one `apps/<folder>` — and runs that area's Vitest
// projects, selected by name with `--project`. The project list comes from
// Vitest itself (the root vite.config.ts `test.projects` globs, each project
// named after its package), so a new app folder gets its own shard with no
// edit here, and a project nothing claims fails the plan instead of being
// dropped. Only the shards a branch's changes can affect are emitted: see
// `selectionFor` for the rules.
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
 * Areas too slow for one runner, and how many Vitest `--shard` parts each is
 * split into. Every other area runs as a single part.
 */
const VITEST_PARTS_BY_AREA: ReadonlyMap<string, number> = new Map([['slices', 2]])

/** A Vitest project: its name (what `--project` matches) and where it lives. */
interface VitestProject {
  readonly name: string
  /** The project's root, relative to the repo root (`apps/relay/relay-react`). */
  readonly root: string
}

const TestShard = Schema.Struct({
  /** The shard's label, shown in the job name: `Test (<name>)`. */
  name: Schema.String,
  /** Names of the Vitest projects the shard runs, each passed as `--project`. */
  projects: Schema.Array(Schema.String),
  /** Vitest's `--shard <index>/<count>`, set only on a part of a split area. */
  vitestShard: Schema.optional(Schema.String),
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

/**
 * Group projects into shards by area, splitting each area listed in
 * {@link VITEST_PARTS_BY_AREA} into that many `--shard` parts, and keep the
 * areas `selection` covers. Every project is checked for an area first, so a
 * project no area claims fails the plan even on a branch that wouldn't run it.
 * Shards are sorted by area and each shard's projects by name, so the matrix
 * is stable across runs. Pure — exported for unit testing.
 */
const planShards = (
  projects: readonly VitestProject[],
  selection: ShardSelection
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
  const shards = areas.toSorted().flatMap((area): TestShard[] => {
    const names = (projectsByArea.get(area) ?? []).toSorted()
    const parts = VITEST_PARTS_BY_AREA.get(area) ?? 1
    if (parts === 1) return [{ name: area, projects: names }]
    return Array.from({ length: parts }, (_, i) => ({
      name: `${area} ${i + 1}/${parts}`,
      projects: names,
      vitestShard: `${i + 1}/${parts}`,
    }))
  })
  return Either.right(shards)
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

const formatSummary = (selection: ShardSelection, shards: readonly TestShard[]): string =>
  [
    selection._tag === 'AllAreas'
      ? `test shards: all ${shards.length} (${selection.reason})`
      : `test shards: ${shards.length}, for ${selection.packageDirs.length} affected packages`,
    ...shards.map((shard) => `  ${shard.name}: ${shard.projects.length} projects`),
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

export type { ShardSelection, VitestProject }
export {
  allAreas,
  areaOf,
  loadVitestProjects,
  planShards,
  selectionFor,
  selectsArea,
  UnassignedProjectsError,
}
