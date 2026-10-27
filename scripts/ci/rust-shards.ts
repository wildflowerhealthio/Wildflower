#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, posix, relative } from 'node:path'

import { isEntrypoint } from '../entrypoint.ts'

// Emits the GitHub Actions matrix ci-rust.yml's `test` job fans out over:
// `{ include: [{ name, filter }, ...] }`, one entry per test shard. A shard is
// a fixed group of workspace crates, listed in `SHARDS`; its `filter` is the
// nextest filterset selecting those crates' tests. Every shard still builds the
// whole workspace (`--workspace`), so dependency features unify exactly as the
// warmed cache built them; the filter only narrows what runs. A crate no shard
// claims fails the plan instead of going untested.
//
// Only the shards a branch's changes can affect are emitted: those holding a
// changed crate or a crate depending on one through the workspace path deps.
// See `selectionFor` for the rules.
//
// Imports only `node:` builtins, unlike the other scripts: the planning job
// runs it on a bare Node with no `vp install`, which keeps the plan — the
// step every test runner waits on — to a few seconds.

/** A workspace crate, as `cargo metadata --no-deps` describes it. */
interface Crate {
  readonly name: string
  /** The crate's directory, relative to the repo root (`apps/relay/relay-server`). */
  readonly dir: string
  /** Names of the workspace crates this one depends on through a `path` dep. */
  readonly pathDeps: readonly string[]
}

/** A group of crates whose tests run together on one runner. */
interface ShardDefinition {
  /** The shard's label, shown in the job name: `Test (<name>)`. */
  readonly name: string
  readonly crates: readonly string[]
}

/** One matrix entry: a shard and the nextest filterset that selects its tests. */
interface TestShard {
  readonly name: string
  readonly filter: string
}

/**
 * The test shards, sized so each runs its tests in well under a minute on a
 * 4-core runner; the workspace test build each one pays dominates. A shard
 * groups a crate with the crates only it reaches, so a change to a leaf crate
 * runs one shard and a change to a shared crate runs every shard depending on
 * it. A new crate goes in the shard of the crates it serves.
 */
const SHARDS: readonly ShardDefinition[] = [
  {
    name: 'authorization-server',
    crates: [
      'wildflowerhealthio-authorization-server',
      'wildflowerhealthio-persistence',
      'wildflowerhealthio-scope-capabilities',
      'wildflowerhealthio-scopes',
      'wildflowerhealthio-shared-structures',
      'wildflowerhealthio-token-revocation',
    ],
  },
  {
    name: 'wildflower-server',
    crates: [
      'wildflowerhealthio-apps',
      'wildflowerhealthio-databases',
      'wildflowerhealthio-fhir-r4',
      'wildflowerhealthio-kitchen-sink',
      'wildflowerhealthio-ohif-server',
      'wildflowerhealthio-rathole-settings',
      'wildflowerhealthio-request-log',
      'wildflowerhealthio-tunnel',
      'wildflowerhealthio-wildflower-server',
    ],
  },
  {
    name: 'host',
    crates: [
      'host-app',
      'tauri-plugin-native-page-browser',
      'tauri-plugin-native-webview',
      'wildflowerhealthio-browser-sniffer-tauri',
      'wildflowerhealthio-recorder',
      'wildflowerhealthio-recorder-tauri',
      'wildflowerhealthio-servers',
      'wildflowerhealthio-servers-tauri',
      'wildflowerhealthio-tauri-unit-runner',
      'wildflowerhealthio-unit-runner',
    ],
  },
  { name: 'relay', crates: ['wildflowerhealthio-relay-server'] },
]

/**
 * Files that change what every crate compiles or how every test runs: the
 * toolchain and lockfile, the root manifest's lints and shared dependency
 * features, and the CI plumbing itself. Any one runs every shard.
 */
const WHOLE_WORKSPACE_FILES: ReadonlySet<string> = new Set([
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'scripts/checks/rust.sh',
  'scripts/ci/rust-shards.ts',
  'scripts/entrypoint.ts',
  'scripts/ci/stub-embedded-bundles.sh',
  '.github/workflows/ci.yml',
  '.github/workflows/ci-rust.yml',
])

/** Directories whose every file runs every shard, as {@link WHOLE_WORKSPACE_FILES}. */
const WHOLE_WORKSPACE_DIRS: readonly string[] = ['.github/actions/setup-tauri-linux-deps/']

/**
 * Inputs a crate compiles or tests against from outside its own directory and
 * outside its parent: ci.yml's `rust` filter lists the same paths.
 */
const OUTSIDE_INPUTS: ReadonlyMap<string, string> = new Map([
  // The bootstrap bundle wildflowerhealthio-browser-sniffer-tauri `include_str!`s.
  ['slices/browser-sniffer/browser-sniffer-tauri-js/', 'wildflowerhealthio-browser-sniffer-tauri'],
  // The signed request wildflowerhealthio-relay-server's signature test verifies.
  ['apps/relay/relay-core-js/src/signing/fixtures/', 'wildflowerhealthio-relay-server'],
  // The Recorder's wire golden file, which wildflowerhealthio-browser-sniffer-tauri
  // reads from beside the recorder crates.
  ['apps/host/recorder/recorder-wire-golden.json', 'wildflowerhealthio-browser-sniffer-tauri'],
  // The App Catalog, whose preassigned clients wildflowerhealthio-authorization-server
  // holds to the rows its migrations seed.
  ['apps/app-catalog/app-catalog-web/public/apps.json', 'wildflowerhealthio-authorization-server'],
])

/** Which shards a branch's test run covers. */
type ShardSelection =
  /** Every shard: the change reaches every crate. */
  | { readonly _tag: 'AllShards'; readonly reason: string }
  /** The shards holding one of these crates. */
  | { readonly _tag: 'AffectedCrates'; readonly crates: ReadonlySet<string> }

/** The `cargo metadata` fields the plan reads; anything else is ignored. */
interface Metadata {
  readonly workspace_root: string
  readonly packages: readonly {
    readonly name: string
    readonly manifest_path: string
    readonly dependencies: readonly { readonly name: string; readonly path?: string }[]
  }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isMetadata = (value: unknown): value is Metadata =>
  isRecord(value) &&
  typeof value['workspace_root'] === 'string' &&
  Array.isArray(value['packages']) &&
  value['packages'].every(
    (p: unknown) =>
      isRecord(p) &&
      typeof p['name'] === 'string' &&
      typeof p['manifest_path'] === 'string' &&
      Array.isArray(p['dependencies']) &&
      p['dependencies'].every(
        (d: unknown) =>
          isRecord(d) &&
          typeof d['name'] === 'string' &&
          (d['path'] === undefined || typeof d['path'] === 'string')
      )
  )

/**
 * The workspace crates in `cargo metadata --no-deps` output. Path deps are
 * matched to crates by directory, not name: a renamed path dep
 * (`foo = { path = "…", package = "real" }`) can surface its alias as the
 * name, but its `path` is always the real crate's directory. Pure — exported
 * for unit testing.
 */
const cratesFromMetadata = (metadata: Metadata): readonly Crate[] => {
  const relativeDir = (path: string): string =>
    relative(metadata.workspace_root, path).split('\\').join('/')
  const nameByDir = new Map(
    metadata.packages.map((p) => [relativeDir(dirname(p.manifest_path)), p.name])
  )
  return metadata.packages.map((p) => ({
    name: p.name,
    dir: relativeDir(dirname(p.manifest_path)),
    pathDeps: [
      ...new Set(
        p.dependencies.flatMap((d) => {
          const name = d.path === undefined ? undefined : nameByDir.get(relativeDir(d.path))
          return name === undefined ? [] : [name]
        })
      ),
    ],
  }))
}

/** `seed` plus every crate depending on one of them, directly or not. */
const withDependents = (seed: ReadonlySet<string>, crates: readonly Crate[]): Set<string> => {
  const reached = new Set(seed)
  let grew = true
  while (grew) {
    grew = false
    for (const crate of crates) {
      if (!reached.has(crate.name) && crate.pathDeps.some((dep) => reached.has(dep))) {
        reached.add(crate.name)
        grew = true
      }
    }
  }
  return reached
}

/**
 * The crates `file` is an input to: the crate whose directory holds it; else
 * every crate under the file's directory (a file sitting beside crate
 * directories, as `servers-rust` includes
 * `apps/host/servers/servers-wire-golden.json` from its parent) together with
 * its {@link OUTSIDE_INPUTS} owners. Any other file — TypeScript, docs, the
 * repo root's other config — is no crate's input.
 */
const cratesReading = (file: string, crates: readonly Crate[]): readonly string[] => {
  const owner = crates
    .filter((c) => file.startsWith(`${c.dir}/`))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0]
  if (owner !== undefined) return [owner.name]
  const parent = posix.dirname(file)
  const beside =
    parent === '.' ? [] : crates.filter((c) => c.dir.startsWith(`${parent}/`)).map((c) => c.name)
  const outside = [...OUTSIDE_INPUTS]
    .filter(([prefix]) => file.startsWith(prefix))
    .map(([, name]) => name)
  return [...new Set([...beside, ...outside])]
}

/**
 * The shards a branch's changed files select. A {@link WHOLE_WORKSPACE_FILES}
 * change runs them all; otherwise only the shards holding a crate a changed
 * file is an input to, or a crate depending on one. Pure — exported for unit
 * testing.
 */
const selectionFor = (changed: readonly string[], crates: readonly Crate[]): ShardSelection => {
  const whole = changed.find(
    (file) =>
      WHOLE_WORKSPACE_FILES.has(file) || WHOLE_WORKSPACE_DIRS.some((dir) => file.startsWith(dir))
  )
  if (whole !== undefined) return { _tag: 'AllShards', reason: `changed: ${whole}` }
  const seed = new Set(changed.flatMap((file) => cratesReading(file, crates)))
  return { _tag: 'AffectedCrates', crates: withDependents(seed, crates) }
}

/** The plan can't place every crate in exactly one shard. */
class ShardDefinitionError extends Error {}

/**
 * The matrix entries for `selection`, in {@link SHARDS} order. Every workspace
 * crate must sit in exactly one shard and every listed crate must exist, so a
 * new, renamed or removed crate fails the plan on every branch, not only on
 * one that happens to run its shard. Pure — exported for unit testing.
 */
const planShards = (
  shards: readonly ShardDefinition[],
  crates: readonly Crate[],
  selection: ShardSelection
): readonly TestShard[] => {
  const workspace = new Set(crates.map((c) => c.name))
  const listed = shards.flatMap((s) => s.crates)
  const unclaimed = [...workspace].filter((name) => !listed.includes(name)).toSorted()
  const unknown = listed.filter((name) => !workspace.has(name)).toSorted()
  const repeated = listed.filter((name, i) => listed.indexOf(name) !== i).toSorted()
  const problems = [
    ...(unclaimed.length > 0 ? [`in no shard: ${unclaimed.join(', ')}`] : []),
    ...(unknown.length > 0 ? [`not in the workspace: ${unknown.join(', ')}`] : []),
    ...(repeated.length > 0 ? [`in more than one shard: ${repeated.join(', ')}`] : []),
  ]
  if (problems.length > 0) {
    throw new ShardDefinitionError(
      `Fix SHARDS in scripts/ci/rust-shards.ts — crates ${problems.join('; ')}`
    )
  }
  return shards
    .filter(
      (shard) =>
        selection._tag === 'AllShards' || shard.crates.some((name) => selection.crates.has(name))
    )
    .map((shard) => ({
      name: shard.name,
      filter: shard.crates.map((name) => `package(=${name})`).join(' | '),
    }))
}

const run = (command: string, args: readonly string[]): string =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

/** Every file the branch changes since its merge-base with `origin/main`. */
const changedFiles = (): readonly string[] => {
  const mergeBase = run('git', ['merge-base', 'origin/main', 'HEAD'])
  return run('git', ['diff', '--name-only', '--no-renames', `${mergeBase}..HEAD`])
    .split('\n')
    .filter((line) => line.length > 0)
}

const loadCrates = (): readonly Crate[] => {
  const metadata: unknown = JSON.parse(
    run('cargo', ['metadata', '--no-deps', '--format-version', '1'])
  )
  if (!isMetadata(metadata)) throw new Error('cargo metadata printed an unexpected shape')
  return cratesFromMetadata(metadata)
}

const summary = (selection: ShardSelection, shards: readonly TestShard[]): string =>
  selection._tag === 'AllShards'
    ? `rust test shards: all ${shards.length} (${selection.reason})`
    : `rust test shards: ${shards.map((s) => s.name).join(', ') || 'none'}, for ${selection.crates.size} affected crates`

const main = (): void => {
  const crates = loadCrates()
  const selection = selectionFor(changedFiles(), crates)
  const shards = planShards(SHARDS, crates, selection)
  process.stderr.write(`${summary(selection, shards)}\n`)
  process.stdout.write(`${JSON.stringify({ include: shards })}\n`)
}

if (isEntrypoint(import.meta.url)) main()

export type { Crate, ShardDefinition, ShardSelection, TestShard }
export {
  cratesFromMetadata,
  cratesReading,
  planShards,
  selectionFor,
  ShardDefinitionError,
  SHARDS,
  withDependents,
}
