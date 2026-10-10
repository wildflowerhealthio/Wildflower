// The workspace's package graph — every TS package and Rust crate with the
// workspace packages it depends on — and the layering rules it must follow.
// Run by scripts/package-graph.test.ts under `vp test`; the rules are
// explained in docs/Dependencies/Package Graph Rules Explanation.md.
import { readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { Effect, Match, Schema } from 'effect'
import { parse as parseToml } from 'smol-toml'

import { loadPackages } from './risk-map.ts'

/** Which manifest a {@link WorkspacePackage} was read from. */
type Ecosystem = 'npm' | 'cargo'

/** A TS package or Rust crate in the workspace, with its in-workspace dependencies. */
interface WorkspacePackage {
  readonly name: string
  /** Directory of its manifest, relative to the repo root. */
  readonly relDir: string
  readonly ecosystem: Ecosystem
  /**
   * Workspace packages it needs to build or run: npm `dependencies` and
   * `peerDependencies`, Cargo `[dependencies]` and `[build-dependencies]`.
   */
  readonly runtimeDependencyNames: ReadonlySet<string>
  /** Workspace packages only its tests need: npm `devDependencies`, Cargo `[dev-dependencies]`. */
  readonly devDependencyNames: ReadonlySet<string>
}

// ── Reading the graph ────────────────────────────────────────────────────────

const CargoDependency = Schema.Union(
  Schema.String,
  Schema.Struct({
    path: Schema.optional(Schema.String),
    workspace: Schema.optional(Schema.Boolean),
  })
)

const CargoDependencyTable = Schema.Record({ key: Schema.String, value: CargoDependency })

const CargoDependencyTables = {
  dependencies: Schema.optional(CargoDependencyTable),
  'dev-dependencies': Schema.optional(CargoDependencyTable),
  'build-dependencies': Schema.optional(CargoDependencyTable),
}

const CrateManifest = Schema.Struct({
  package: Schema.Struct({ name: Schema.String }),
  ...CargoDependencyTables,
  target: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Struct(CargoDependencyTables) })
  ),
})
type CrateManifest = Schema.Schema.Type<typeof CrateManifest>

const WorkspaceManifest = Schema.Struct({
  workspace: Schema.Struct({
    members: Schema.Array(Schema.String),
    dependencies: Schema.optional(CargoDependencyTable),
  }),
})

const decodeCrateManifest = Schema.decodeUnknownSync(CrateManifest)
const decodeWorkspaceManifest = Schema.decodeUnknownSync(WorkspaceManifest)

const readToml = (repoRoot: string, relPath: string): unknown =>
  parseToml(readFileSync(join(repoRoot, relPath), 'utf8'))

type CargoDependencyTableName = keyof typeof CargoDependencyTables

/**
 * Directories, relative to the repo root, of the path dependencies a crate
 * declares in the named tables, including their `[target.<cfg>.…]` forms —
 * directly, or through `{ workspace = true }` onto a path entry in the root
 * manifest's `[workspace.dependencies]`.
 */
const crateDependencyDirs = (
  crateDir: string,
  manifest: CrateManifest,
  tableNames: readonly CargoDependencyTableName[],
  workspaceDependencyDirs: ReadonlyMap<string, string>
): readonly string[] => {
  const tables = [manifest, ...Object.values(manifest.target ?? {})].flatMap((section) =>
    tableNames.map((tableName) => section[tableName])
  )
  return tables.flatMap((table) =>
    Object.entries(table ?? {}).flatMap(([key, dependency]) => {
      if (typeof dependency === 'string') return []
      if (dependency.path !== undefined) return [normalize(join(crateDir, dependency.path))]
      if (dependency.workspace === true) {
        const inherited = workspaceDependencyDirs.get(key)
        return inherited === undefined ? [] : [inherited]
      }
      return []
    })
  )
}

/** Every workspace member of the root `Cargo.toml`, with its path dependencies. */
const loadCrates = (repoRoot: string): readonly WorkspacePackage[] => {
  const { workspace } = decodeWorkspaceManifest(readToml(repoRoot, 'Cargo.toml'))
  const workspaceDependencyDirs = new Map(
    Object.entries(workspace.dependencies ?? {}).flatMap(([key, dependency]) =>
      typeof dependency !== 'string' && dependency.path !== undefined
        ? [[key, normalize(dependency.path)] as const]
        : []
    )
  )
  const crates = workspace.members.map((memberDir) => ({
    relDir: normalize(memberDir),
    manifest: decodeCrateManifest(readToml(repoRoot, join(memberDir, 'Cargo.toml'))),
  }))
  const crateNameByDir = new Map(crates.map((crate) => [crate.relDir, crate.manifest.package.name]))
  return crates.map((crate) => {
    const crateNamesIn = (tableNames: readonly CargoDependencyTableName[]): ReadonlySet<string> =>
      new Set(
        crateDependencyDirs(
          crate.relDir,
          crate.manifest,
          tableNames,
          workspaceDependencyDirs
        ).flatMap((dependencyDir) => {
          const name = crateNameByDir.get(dependencyDir)
          return name === undefined ? [] : [name]
        })
      )
    return {
      name: crate.manifest.package.name,
      relDir: crate.relDir,
      ecosystem: 'cargo',
      runtimeDependencyNames: crateNamesIn(['dependencies', 'build-dependencies']),
      devDependencyNames: crateNamesIn(['dev-dependencies']),
    }
  })
}

/**
 * The workspace's TS packages (from `pnpm-workspace.yaml`, through
 * `risk-map.ts`'s reader) and Rust crates (from the root `Cargo.toml`).
 */
const loadWorkspacePackages = (repoRoot: string): Effect.Effect<readonly WorkspacePackage[]> =>
  Effect.gen(function* () {
    const npmPackages = yield* loadPackages(repoRoot)
    return [
      ...npmPackages.map((npmPackage): WorkspacePackage => ({
        name: npmPackage.name,
        relDir: npmPackage.relDir,
        ecosystem: 'npm',
        runtimeDependencyNames: npmPackage.deps,
        devDependencyNames: npmPackage.devDeps,
      })),
      ...loadCrates(repoRoot),
    ]
  })

// ── The rules ────────────────────────────────────────────────────────────────

/** Whether a {@link Dependency} is needed to build or run, or only by tests. */
type DependencyKind = 'runtime' | 'dev'

/** A dependency from one workspace package onto another. */
interface Dependency {
  readonly dependent: WorkspacePackage
  readonly dependency: WorkspacePackage
  /** `runtime` when the dependent lists it as both. */
  readonly kind: DependencyKind
}

/** A rule a {@link Dependency} or the graph as a whole breaks. */
type Violation =
  | { readonly _tag: 'CoreDependsOnAdapter'; readonly dependency: Dependency }
  | { readonly _tag: 'ReachesIntoApp'; readonly dependency: Dependency; readonly app: string }
  | { readonly _tag: 'Cycle'; readonly ecosystem: Ecosystem; readonly names: readonly string[] }

/** Name suffixes of the pure layer: `<slice>-core`, and an app's `<app>-core-js`. */
const CORE_SUFFIXES = ['-core', '-core-js']

/** Name suffixes of a platform adapter, which a core package never depends on. */
const ADAPTER_SUFFIXES = ['-react', '-rust', '-tauri', '-tauri-js', '-node', '-web']

const isCore = (workspacePackage: WorkspacePackage): boolean =>
  CORE_SUFFIXES.some((suffix) => workspacePackage.name.endsWith(suffix))

const isAdapter = (workspacePackage: WorkspacePackage): boolean =>
  ADAPTER_SUFFIXES.some((suffix) => workspacePackage.name.endsWith(suffix))

/** The `<name>` of the `apps/<name>/` folder a package sits in, if it is in one. */
const appOf = (workspacePackage: WorkspacePackage): string | undefined => {
  const [root, app] = workspacePackage.relDir.split('/')
  return root === 'apps' ? app : undefined
}

/**
 * The one package allowed outside its app's folder: the site assembles every
 * app's `-web` entry into wildflowerhealth.io.
 */
const SITE_ASSEMBLY = 'wildflower-site-web'

/**
 * Whether a dependency into another app's folder is allowed: the site's
 * assembly of `-web` entries, or one app's dev-dependency on another, so its
 * tests can run against the other's real code. A slice or `global/` package
 * reaches into no app, not even from its tests.
 */
const mayReachIntoApp = ({ dependent, dependency, kind }: Dependency): boolean =>
  (kind === 'dev' && appOf(dependent) !== undefined) ||
  (dependent.name === SITE_ASSEMBLY && dependency.name.endsWith('-web'))

/** The rules a single {@link Dependency} breaks. */
const dependencyViolations = (dependency: Dependency): readonly Violation[] => {
  const violations: Violation[] = []
  if (isCore(dependency.dependent) && isAdapter(dependency.dependency)) {
    violations.push({ _tag: 'CoreDependsOnAdapter', dependency })
  }
  const dependencyApp = appOf(dependency.dependency)
  if (
    dependencyApp !== undefined &&
    appOf(dependency.dependent) !== dependencyApp &&
    !mayReachIntoApp(dependency)
  ) {
    violations.push({ _tag: 'ReachesIntoApp', dependency, app: dependencyApp })
  }
  return violations
}

/**
 * The cycles in one ecosystem's dependency graph: each strongly connected
 * component of two or more packages.
 *
 * @param adjacency - Every package's name mapped to the names it depends on
 * @returns Each cycle's member names, sorted, in a stable order
 *
 * @remarks
 * Tarjan's algorithm, iterative so a deep graph can't overflow the stack.
 * Names an adjacency list mentions but doesn't key are treated as leaves.
 *
 * A package that depends on itself is not a cycle: it is how a crate's tests
 * turn on its own test-only features, and how a TS package's tests import it
 * by name.
 */
const findCycles = (
  adjacency: ReadonlyMap<string, ReadonlySet<string>>
): readonly (readonly string[])[] => {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []
  let nextIndex = 0

  for (const root of adjacency.keys()) {
    if (index.has(root)) continue
    const work: { readonly name: string; readonly successors: Iterator<string> }[] = []
    const visit = (name: string): void => {
      index.set(name, nextIndex)
      lowLink.set(name, nextIndex)
      nextIndex += 1
      stack.push(name)
      onStack.add(name)
      work.push({ name, successors: (adjacency.get(name) ?? new Set()).values() })
    }
    visit(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const next = frame.successors.next()
      if (!next.done) {
        const successor = next.value
        if (!index.has(successor)) visit(successor)
        else if (onStack.has(successor)) {
          lowLink.set(frame.name, Math.min(lowLink.get(frame.name)!, index.get(successor)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        lowLink.set(parent.name, Math.min(lowLink.get(parent.name)!, lowLink.get(frame.name)!))
      }
      if (lowLink.get(frame.name) !== index.get(frame.name)) continue
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== frame.name)
      if (component.length > 1) cycles.push(component.toSorted())
    }
  }
  return cycles.toSorted((a, b) => a[0].localeCompare(b[0]))
}

/**
 * Every rule the workspace's package graph breaks: a core package depending
 * on an adapter, a package outside `apps/<name>/` depending on one inside it,
 * and a dependency cycle in either ecosystem.
 */
const packageGraphViolations = (packages: readonly WorkspacePackage[]): readonly Violation[] => {
  const ecosystems: readonly Ecosystem[] = ['npm', 'cargo']
  return ecosystems.flatMap((ecosystem) => {
    const ecosystemPackages = packages.filter((p) => p.ecosystem === ecosystem)
    const packageByName = new Map(ecosystemPackages.map((p) => [p.name, p]))
    const dependenciesOf = (dependent: WorkspacePackage): readonly Dependency[] => {
      const kindByName = new Map<string, DependencyKind>([
        ...[...dependent.devDependencyNames].map((name) => [name, 'dev'] as const),
        ...[...dependent.runtimeDependencyNames].map((name) => [name, 'runtime'] as const),
      ])
      return [...kindByName].flatMap(([name, kind]) => {
        const dependency = packageByName.get(name)
        return dependency === undefined || dependency === dependent
          ? []
          : [{ dependent, dependency, kind }]
      })
    }
    const dependencyViolationsFound = ecosystemPackages
      .flatMap(dependenciesOf)
      .flatMap(dependencyViolations)
    const cycles = findCycles(
      new Map(
        ecosystemPackages.map((p) => [
          p.name,
          new Set([...p.runtimeDependencyNames, ...p.devDependencyNames]),
        ])
      )
    ).map((names): Violation => ({ _tag: 'Cycle', ecosystem, names }))
    return [...dependencyViolationsFound, ...cycles]
  })
}

/** One line naming the rule a {@link Violation} breaks and the packages that break it. */
const formatViolation = (violation: Violation): string =>
  Match.value(violation).pipe(
    Match.tagsExhaustive({
      CoreDependsOnAdapter: ({ dependency: { dependent, dependency } }) =>
        `${dependent.name} (${dependent.relDir}) is a core package but depends on the adapter ${dependency.name}`,
      ReachesIntoApp: ({ dependency: { dependent, dependency }, app }) =>
        `${dependent.name} (${dependent.relDir}) depends on ${dependency.name}, which is private to apps/${app}/`,
      Cycle: ({ ecosystem, names }) => `${ecosystem} dependency cycle: ${names.join(' ↔ ')}`,
    })
  )

export type { Dependency, DependencyKind, Ecosystem, Violation, WorkspacePackage }
export { findCycles, formatViolation, loadWorkspacePackages, packageGraphViolations }
