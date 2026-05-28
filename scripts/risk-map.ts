#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// Emits a JSON map of `{ <pkgName>: <multiplier> }` for the kitchen-sink
// `numRunsFor` helper to consume via the FC_RISK_MAP env var. Packages
// reachable in the reverse workspace dep graph from a changed file get the
// HIGH multiplier (1.0); everything else gets LOW (0.2). Root-config or
// lockfile changes promote every package to HIGH.
import { Console, Effect, Either, Option, pipe, Schema } from 'effect'

const HIGH = 1.0
const LOW = 0.2

const ROOT_CONFIG_FILES = new Set(['vite.config.base.ts', 'vite.config.ts', 'pnpm-workspace.yaml'])

const WORKSPACE_PACKAGE_PATTERNS = [
  'apps/*/package.json',
  'global/*/package.json',
  'global/effect-messaging/*/package.json',
  'global/expo-effect-platform/example/package.json',
  'slices/**/package.json',
] as const

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
    const seen = new Set<string>()
    const pkgs: Pkg[] = []
    for (const pattern of WORKSPACE_PACKAGE_PATTERNS) {
      for (const rel of globSync(pattern, {
        cwd: repoRoot,
        exclude: (p: string) => p.includes('node_modules') || p.includes('dist'),
      })) {
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

Effect.runSync(Effect.orDie(main))
