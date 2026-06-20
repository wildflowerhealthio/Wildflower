#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { dirname, relative } from 'node:path'
// Prints the workspace crates affected by changes vs origin/main, for the git
// hooks' lightweight Rust checks (scripts/checks/rust.sh pre-commit|pre-push).
// CI still runs the full `cargo --workspace`, so this only narrows local runs.
//
// stdout is one of:
//   - newline-separated crate names = affected set (changed crates + every
//     workspace crate that transitively depends on one of them), or
//   - `__WORKSPACE__` = can't scope safely (a global file changed, or git /
//     cargo metadata was unavailable) — the caller then runs the full workspace, or
//   - nothing = no Rust-relevant change vs main.
import { Console, Effect, Schema } from 'effect'

const WORKSPACE = '__WORKSPACE__'

// Files that can affect the whole workspace — don't try to scope past them.
const GLOBAL_FILES = new Set(['Cargo.lock', 'rust-toolchain.toml', 'deny.toml', 'Cargo.toml'])

const Dependency = Schema.Struct({
  name: Schema.String,
  // Only path (in-workspace) deps carry a `path`; registry deps don't.
  path: Schema.optional(Schema.String),
})

const CargoPackage = Schema.Struct({
  name: Schema.String,
  manifest_path: Schema.String,
  dependencies: Schema.Array(Dependency),
})

const Metadata = Schema.Struct({
  workspace_root: Schema.String,
  packages: Schema.Array(CargoPackage),
})

const decodeMetadata = Schema.decodeUnknownSync(Metadata)

interface Crate {
  readonly name: string
  readonly relDir: string
  // Directories of this crate's in-workspace path deps (relative to the
  // workspace root), used to build the reverse-dep graph by location.
  readonly depDirs: readonly string[]
}

const sh = (cmd: string): Effect.Effect<string, Error> =>
  Effect.try(() => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim())

const splitLines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

const reverseDepClosure = (
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

const affected = Effect.gen(function* () {
  // Base = merge-base with origin/main. The optional `HEAD` argv (passed by the
  // pre-push hook) diffs the committed push range `base..HEAD`, scoping to what
  // is actually being pushed rather than the dirty working tree. With no arg
  // (pre-commit) we diff base against the working tree so staged AND unstaged
  // edits count (the pre-commit change isn't in HEAD yet). Only `HEAD` is
  // accepted as the endpoint — anything else is ignored — so nothing
  // attacker-controlled reaches the shell.
  const endpoint = process.argv[2] === 'HEAD' ? 'HEAD' : undefined
  const base = yield* sh('git merge-base origin/main HEAD')
  const range = endpoint === undefined ? base : `${base} ${endpoint}`
  const changed = splitLines(yield* sh(`git diff --name-only ${range}`))

  if (changed.some((file) => GLOBAL_FILES.has(file))) return [WORKSPACE]

  const rustish = changed.filter((file) => file.endsWith('.rs') || file.endsWith('Cargo.toml'))
  if (rustish.length === 0) return []

  const metaJson = yield* sh('cargo metadata --no-deps --format-version 1')
  const meta = yield* Effect.try(() => decodeMetadata(JSON.parse(metaJson) as unknown))

  const crates: readonly Crate[] = meta.packages.map((p) => ({
    name: p.name,
    relDir: relative(meta.workspace_root, dirname(p.manifest_path)),
    // Match in-workspace deps by their on-disk directory, not by name. A renamed
    // path dep (`foo = { path = "…", package = "real" }`) can surface the alias
    // in cargo's dep fields, but the resolved `path` always points at the real
    // crate dir — so directory matching can't drop a dependent edge.
    depDirs: p.dependencies.flatMap((d) =>
      d.path === undefined ? [] : [relative(meta.workspace_root, d.path)]
    ),
  }))

  const nameByDir = new Map<string, string>()
  for (const c of crates) nameByDir.set(c.relDir, c.name)

  const reverse = new Map<string, Set<string>>()
  for (const c of crates) reverse.set(c.name, new Set())
  for (const c of crates) {
    for (const depDir of c.depDirs) {
      const depName = nameByDir.get(depDir)
      if (depName !== undefined) reverse.get(depName)?.add(c.name)
    }
  }

  // Map each changed file to its owning crate (longest matching dir prefix).
  const byDepth = crates
    .filter((c) => c.relDir !== '')
    .toSorted((a, b) => b.relDir.length - a.relDir.length)
  const seed = new Set<string>()
  for (const file of rustish) {
    const owner = byDepth.find((c) => file === c.relDir || file.startsWith(`${c.relDir}/`))
    if (owner) seed.add(owner.name)
  }
  if (seed.size === 0) return []

  return [...reverseDepClosure(seed, reverse)].toSorted()
})

const main = affected.pipe(
  // Any failure (no origin/main, git or cargo error, undecodable metadata) means
  // "can't scope" — fall back to the full workspace rather than skip coverage.
  Effect.catchAll(() => Effect.succeed<readonly string[]>([WORKSPACE])),
  Effect.flatMap((lines) => (lines.length === 0 ? Effect.void : Console.log(lines.join('\n'))))
)

Effect.runSync(main)
