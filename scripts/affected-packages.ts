import { execSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { basename, dirname, join, matchesGlob, normalize } from 'node:path'

// Which workspace packages a branch's changes can affect: the packages owning
// a changed file, plus every package that depends on one of them, directly or
// through others (the reverse workspace dependency graph). A package depends
// on another when its manifest names it, or when its source imports a file
// out of the other's folder by relative path. Shared by
// `risk-map.ts` (full property-test runs for affected packages) and
// `ci/test-shards.ts` (CI test shards only for affected areas), and its
// workspace reader by `package-graph.ts`, so the three never disagree about
// which packages exist or what a change reaches.
import { Effect, Either, Option, pipe, Schema } from 'effect'
import { parse as parseYaml } from 'yaml'

const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/**
 * Repo-root files every package's build or tests read, so a change to one
 * affects every package: the shared Vite configs, the workspace definition and
 * catalog, the root manifest and the lockfile.
 */
const ROOT_CONFIG_FILES: ReadonlySet<string> = new Set([
  'vite.config.base.ts',
  'vite.config.ts',
  WORKSPACE_FILE,
  'package.json',
  'pnpm-lock.yaml',
])

/** Positive and negative package globs read from `pnpm-workspace.yaml`. */
interface WorkspaceGlobs {
  /** Directory globs whose packages ARE workspace members (e.g. `apps/*`). */
  readonly positive: readonly string[]
  /** `!`-prefixed globs (with the `!` stripped) excluded from the workspace. */
  readonly negative: readonly string[]
}

/**
 * Split raw `pnpm-workspace.yaml` `packages` entries into positive globs and
 * negations (the `!`-prefixed entries, with the leading `!` stripped). Pure —
 * exported for unit testing.
 */
const partitionWorkspaceGlobs = (entries: readonly string[]): WorkspaceGlobs => {
  const positive: string[] = []
  const negative: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('!')) negative.push(entry.slice(1))
    else positive.push(entry)
  }
  return { positive, negative }
}

const WorkspaceConfig = Schema.Struct({
  packages: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
})
const decodeWorkspaceConfig = Schema.decodeUnknownSync(WorkspaceConfig)

/**
 * Read the workspace package globs from `pnpm-workspace.yaml` — the single
 * source of truth for which directories are workspace members. Deriving the
 * globs from here (rather than a second hardcoded copy) keeps the two lists
 * from drifting when a workspace root is added or removed.
 */
const readWorkspaceGlobs = (repoRoot: string): WorkspaceGlobs => {
  const raw = readFileSync(join(repoRoot, WORKSPACE_FILE), 'utf8')
  const { packages } = decodeWorkspaceConfig(parseYaml(raw))
  return partitionWorkspaceGlobs(packages)
}

const WorkspaceDeps = Schema.Record({ key: Schema.String, value: Schema.String })

const PackageJson = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(WorkspaceDeps),
  devDependencies: Schema.optional(WorkspaceDeps),
  peerDependencies: Schema.optional(WorkspaceDeps),
})
type PackageJson = Schema.Schema.Type<typeof PackageJson>

const decodePackageJson = Schema.decodeUnknownEither(PackageJson)

/** A pnpm workspace member and the workspace packages it depends on. */
interface Pkg {
  readonly name: string
  readonly relDir: string
  /** Workspace packages it needs at runtime: `dependencies` and `peerDependencies`. */
  readonly deps: ReadonlySet<string>
  /** Workspace packages only its tests and tooling need: `devDependencies`. */
  readonly devDeps: ReadonlySet<string>
}

const sh = (cmd: string, cwd?: string): Effect.Effect<string, Error> =>
  Effect.try(() => execSync(cmd, cwd ? { cwd, encoding: 'utf8' } : { encoding: 'utf8' }).trim())

const splitNonEmptyLines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/**
 * Every file the branch changes: committed since the merge-base with
 * `origin/main`, plus unstaged, staged and untracked work. `--no-renames`
 * lists a moved file at both paths, so the package it left counts as changed
 * too.
 */
const collectChangedFiles = (repoRoot: string): Effect.Effect<ReadonlySet<string>, Error> =>
  Effect.gen(function* () {
    const mergeBase = yield* sh('git merge-base origin/main HEAD', repoRoot)
    const commands = [
      `git diff --name-only --no-renames ${mergeBase}..HEAD`,
      'git diff --name-only --no-renames',
      'git diff --name-only --no-renames --staged',
      'git ls-files --others --exclude-standard',
    ]
    const outputs = yield* Effect.forEach(commands, (cmd) => sh(cmd, repoRoot))
    return new Set(outputs.flatMap(splitNonEmptyLines))
  })

/** The repo root, from git. */
const repoRootFromGit: Effect.Effect<string, Error> = sh('git rev-parse --show-toplevel')

const workspaceDepsIn = (
  sections: readonly (PackageJson['dependencies'] | undefined)[]
): ReadonlySet<string> => {
  const deps = new Set<string>()
  for (const section of sections) {
    if (!section) continue
    for (const [name, ver] of Object.entries(section)) {
      if (ver.startsWith('workspace:')) deps.add(name)
    }
  }
  return deps
}

const tryDecodePackage = (raw: string): Option.Option<PackageJson> =>
  pipe(
    Either.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
    Either.flatMap((parsed) => Either.mapLeft(decodePackageJson(parsed), () => undefined)),
    Either.getRight
  )

/** Every named pnpm workspace member, read from its `package.json`. */
const loadPackages = (repoRoot: string): Effect.Effect<readonly Pkg[]> =>
  Effect.sync(() => {
    const { positive, negative } = readWorkspaceGlobs(repoRoot)
    // pnpm globs match directories; this matches their `package.json`.
    const patterns = positive.map((glob) => `${glob}/package.json`)
    // A `package.json` at `rel` is excluded when it (or its directory) matches
    // a `!`-negation — testing both covers `.../**` globs and exact-dir globs.
    const isExcluded = (rel: string): boolean =>
      rel.includes('node_modules') ||
      rel.includes('dist') ||
      negative.some((neg) => matchesGlob(rel, neg) || matchesGlob(dirname(rel), neg))
    const seen = new Set<string>()
    const pkgs: Pkg[] = []
    for (const pattern of patterns) {
      for (const rel of globSync(pattern, { cwd: repoRoot, exclude: isExcluded })) {
        if (seen.has(rel)) continue
        seen.add(rel)
        const raw = readFileSync(join(repoRoot, rel), 'utf8')
        const decoded = tryDecodePackage(raw)
        if (Option.isNone(decoded)) continue
        const json = decoded.value
        if (!json.name) continue
        pkgs.push({
          name: json.name,
          relDir: dirname(rel),
          deps: workspaceDepsIn([json.dependencies, json.peerDependencies]),
          devDeps: workspaceDepsIn([json.devDependencies]),
        })
      }
    }
    return pkgs
  })

/** The innermost package whose directory holds `file`, if any. */
const ownerOf = (file: string, packagesByDepth: readonly Pkg[]): Option.Option<Pkg> =>
  Option.fromNullable(
    packagesByDepth.find((p) => file === p.relDir || file.startsWith(`${p.relDir}/`))
  )

/** Files whose relative imports can reach into another package's folder. */
const SOURCE_FILE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

/** Folders holding no hand-written source: installs, build outputs, Cargo targets. */
const NON_SOURCE_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'target'])

/** `from '../x'`, `import('../x')`, `import '../x'`, `require('../x')`. */
const RELATIVE_IMPORT = /\b(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g

/**
 * The relative import specifiers in `source`, without a `?raw`-style query.
 * Pure — exported for unit testing.
 */
const relativeImportsIn = (source: string): readonly string[] =>
  Array.from(
    source.matchAll(RELATIVE_IMPORT),
    ([, specifier = '']) => specifier.split('?')[0] ?? ''
  )

/** Package names keyed by the name of a package that imports from them. */
type PathImports = ReadonlyMap<string, ReadonlySet<string>>

/**
 * The packages each package imports a file from by relative path — a file no
 * manifest edge covers, such as `apps/host/host-app/tauri-shared-config.json`
 * or an OpenAPI snapshot, read straight out of the other package's folder.
 */
const loadPathImports = (repoRoot: string, packages: readonly Pkg[]): Effect.Effect<PathImports> =>
  Effect.sync(() => {
    const packagesByDepth = packages.toSorted((a, b) => b.relDir.length - a.relDir.length)
    const files = new Set(
      packages.flatMap((p) =>
        globSync(`${p.relDir}/${SOURCE_FILE_GLOB}`, {
          cwd: repoRoot,
          exclude: (path) => NON_SOURCE_DIRS.has(basename(path)),
        })
      )
    )
    const imports = new Map<string, Set<string>>()
    for (const file of files) {
      const importer = ownerOf(file, packagesByDepth)
      if (Option.isNone(importer)) continue
      const source = readFileSync(join(repoRoot, file), 'utf8')
      for (const specifier of relativeImportsIn(source)) {
        const imported = ownerOf(normalize(join(dirname(file), specifier)), packagesByDepth)
        if (Option.isNone(imported) || imported.value.name === importer.value.name) continue
        const importedNames = imports.get(importer.value.name) ?? new Set<string>()
        importedNames.add(imported.value.name)
        imports.set(importer.value.name, importedNames)
      }
    }
    return imports
  })

const buildReverseDeps = (
  packages: readonly Pkg[],
  pathImports: PathImports
): ReadonlyMap<string, ReadonlySet<string>> => {
  const reverse = new Map<string, Set<string>>()
  for (const p of packages) reverse.set(p.name, new Set())
  for (const p of packages) {
    for (const dep of [...p.deps, ...p.devDeps, ...(pathImports.get(p.name) ?? [])]) {
      reverse.get(dep)?.add(p.name)
    }
  }
  return reverse
}

/** `seed` plus every package that depends on one of them, transitively. */
const withDependers = (
  seed: ReadonlySet<string>,
  reverse: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlySet<string> => {
  const reached = new Set(seed)
  const queue = [...seed]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const depender of reverse.get(cur) ?? []) {
      if (reached.has(depender)) continue
      reached.add(depender)
      queue.push(depender)
    }
  }
  return reached
}

/** What a set of changed files reaches in the workspace. */
interface AffectedPackages {
  /** Changed {@link ROOT_CONFIG_FILES}: any one affects every package. */
  readonly rootConfigChanges: readonly string[]
  /** Changed files outside every package (root config files excluded). */
  readonly unownedChanges: readonly string[]
  /** Names of the packages owning a changed file. */
  readonly changed: ReadonlySet<string>
  /**
   * {@link changed} plus every package depending on one, through a manifest
   * or a {@link PathImports} edge, transitively.
   */
  readonly affected: ReadonlySet<string>
}

/**
 * Sort `changedFiles` into root-config changes, changes no package owns, and
 * the packages they change and reach through the manifests and
 * `pathImports`. What each counts for is the caller's call. Pure — exported
 * for unit testing.
 */
const findAffectedPackages = (
  changedFiles: Iterable<string>,
  packages: readonly Pkg[],
  pathImports: PathImports = new Map()
): AffectedPackages => {
  const packagesByDepth = packages.toSorted((a, b) => b.relDir.length - a.relDir.length)
  const rootConfigChanges: string[] = []
  const unownedChanges: string[] = []
  const changed = new Set<string>()
  for (const file of changedFiles) {
    if (ROOT_CONFIG_FILES.has(file)) {
      rootConfigChanges.push(file)
      continue
    }
    Option.match(ownerOf(file, packagesByDepth), {
      onNone: () => unownedChanges.push(file),
      onSome: (pkg) => changed.add(pkg.name),
    })
  }
  return {
    rootConfigChanges: rootConfigChanges.toSorted(),
    unownedChanges: unownedChanges.toSorted(),
    changed,
    affected: withDependers(changed, buildReverseDeps(packages, pathImports)),
  }
}

/** The workspace's packages and what the branch's changes reach among them. */
const loadAffectedPackages = (
  repoRoot: string
): Effect.Effect<
  { readonly packages: readonly Pkg[]; readonly affectedPackages: AffectedPackages },
  Error
> =>
  Effect.gen(function* () {
    const changedFiles = yield* collectChangedFiles(repoRoot)
    const packages = yield* loadPackages(repoRoot)
    const pathImports = yield* loadPathImports(repoRoot, packages)
    return {
      packages,
      affectedPackages: findAffectedPackages(changedFiles, packages, pathImports),
    }
  })

export type { AffectedPackages, PathImports, Pkg, WorkspaceGlobs }
export {
  findAffectedPackages,
  loadAffectedPackages,
  loadPackages,
  loadPathImports,
  partitionWorkspaceGlobs,
  readWorkspaceGlobs,
  relativeImportsIn,
  repoRootFromGit,
  ROOT_CONFIG_FILES,
}
