#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { globSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
// Emits a JSON map of `{ <pkgName>: <multiplier> }` for the kitchen-sink
// `numRunsFor` helper to consume via the FC_RISK_MAP env var. Packages
// reachable in the reverse workspace dep graph from a changed file get the
// HIGH multiplier (1.0); everything else gets LOW (0.2). Root-config or
// lockfile changes promote every package to HIGH.
import { Console, Effect, Either, Option, pipe, Schema } from 'effect'
import { parse as parseYaml } from 'yaml'

const HIGH = 1.0
const LOW = 0.2

const WORKSPACE_FILE = 'pnpm-workspace.yaml'

const ROOT_CONFIG_FILES = new Set(['vite.config.base.ts', 'vite.config.ts', WORKSPACE_FILE])

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
 * risk-map's globs from here (rather than a second hardcoded copy) keeps the
 * two lists from drifting when a workspace root is added or removed.
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

const RiskMap = Schema.Record({ key: Schema.String, value: Schema.Number })

const decodePackageJson = Schema.decodeUnknownEither(PackageJson)
const encodeRiskMap = Schema.encodeSync(RiskMap)

interface Pkg {
  readonly name: string
  readonly relDir: string
  readonly deps: ReadonlySet<string>
}

const sh = (cmd: string, cwd?: string): Effect.Effect<string, Error> =>
  Effect.try(() => execSync(cmd, cwd ? { cwd, encoding: 'utf8' } : { encoding: 'utf8' }).trim())

const splitNonEmptyLines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

const collectChangedFiles = (repoRoot: string): Effect.Effect<ReadonlySet<string>, Error> =>
  Effect.gen(function* () {
    const mergeBase = yield* sh('git merge-base origin/main HEAD', repoRoot)
    const commands = [
      `git diff --name-only ${mergeBase}..HEAD`,
      'git diff --name-only',
      'git diff --name-only --staged',
      'git ls-files --others --exclude-standard',
    ]
    const outputs = yield* Effect.forEach(commands, (cmd) => sh(cmd, repoRoot))
    return new Set(outputs.flatMap(splitNonEmptyLines))
  })

const depsFromPackageJson = (json: PackageJson): ReadonlySet<string> => {
  const deps = new Set<string>()
  for (const section of [json.dependencies, json.devDependencies, json.peerDependencies]) {
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

const loadPackages = (repoRoot: string): Effect.Effect<readonly Pkg[]> =>
  Effect.sync(() => {
    const { positive, negative } = readWorkspaceGlobs(repoRoot)
    // pnpm globs match directories; risk-map matches their `package.json`.
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
        pkgs.push({ name: json.name, relDir: dirname(rel), deps: depsFromPackageJson(json) })
      }
    }
    return pkgs
  })

const ownerFor = (file: string, packagesByDepth: readonly Pkg[]): Option.Option<Pkg> =>
  Option.fromNullable(
    packagesByDepth.find((p) => file === p.relDir || file.startsWith(`${p.relDir}/`))
  )

const buildReverseDeps = (packages: readonly Pkg[]): ReadonlyMap<string, ReadonlySet<string>> => {
  const reverse = new Map<string, Set<string>>()
  for (const p of packages) reverse.set(p.name, new Set())
  for (const p of packages) {
    for (const dep of p.deps) {
      reverse.get(dep)?.add(p.name)
    }
  }
  return reverse
}

const propagateRisk = (
  seed: ReadonlySet<string>,
  reverse: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlySet<string> => {
  const high = new Set(seed)
  const queue = [...seed]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const depender of reverse.get(cur) ?? []) {
      if (high.has(depender)) continue
      high.add(depender)
      queue.push(depender)
    }
  }
  return high
}

const buildRiskMap = (
  packages: readonly Pkg[],
  highRisk: ReadonlySet<string>
): Record<string, number> => {
  const map: Record<string, number> = {}
  for (const p of packages) map[p.name] = highRisk.has(p.name) ? HIGH : LOW
  return map
}

const formatSummary = (
  highRisk: ReadonlySet<string>,
  totalPackages: number,
  directlyChanged: number
): string => {
  const highList = [...highRisk].toSorted()
  const lowCount = totalPackages - highRisk.size
  const head = `risk: ${highRisk.size} high (${HIGH}), ${lowCount} low (${LOW}) — changed: ${directlyChanged}`
  if (highList.length === 0) return head
  if (highList.length <= 20) return `${head}\n  high: ${highList.join(', ')}`
  return `${head}\n  high (first 20): ${highList.slice(0, 20).join(', ')}, ...`
}

const main = Effect.gen(function* () {
  const repoRoot = yield* sh('git rev-parse --show-toplevel')
  const changedFiles = yield* collectChangedFiles(repoRoot)
  const packages = yield* loadPackages(repoRoot)

  const rootConfigChange = [...changedFiles].find((f) => ROOT_CONFIG_FILES.has(f))
  if (rootConfigChange !== undefined) {
    const map = Object.fromEntries(packages.map((p) => [p.name, HIGH]))
    yield* Console.error(
      `risk: root config changed (${rootConfigChange}) — all ${packages.length} packages at high risk (${HIGH})`
    )
    yield* Console.log(JSON.stringify(encodeRiskMap(map)))
    return
  }

  const packagesByDepth = [...packages].toSorted((a, b) => b.relDir.length - a.relDir.length)
  const directlyChanged = new Set<string>()
  for (const file of changedFiles) {
    Option.match(ownerFor(file, packagesByDepth), {
      onNone: () => undefined,
      onSome: (pkg) => directlyChanged.add(pkg.name),
    })
  }

  const reverse = buildReverseDeps(packages)
  const highRisk = propagateRisk(directlyChanged, reverse)
  const map = buildRiskMap(packages, highRisk)

  yield* Console.error(formatSummary(highRisk, packages.length, directlyChanged.size))
  yield* Console.log(JSON.stringify(encodeRiskMap(map)))
})

/**
 * True when this module is the process entrypoint (`node scripts/risk-map.ts`),
 * false when imported — e.g. by the unit test, which must not run `main`'s git
 * queries or emit to stdout on import.
 */
const runAsScript = (): boolean => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runAsScript()) Effect.runSync(Effect.orDie(main))

export type { WorkspaceGlobs }
export { buildRiskMap, loadPackages, partitionWorkspaceGlobs, readWorkspaceGlobs }
