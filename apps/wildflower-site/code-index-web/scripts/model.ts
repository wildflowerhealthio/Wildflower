// The code index's per-package model, shared by the Rust and TypeScript
// extractors, and the workspace lookups both need.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Schema } from 'effect'

/** One top-level item: a Rust item or `impl` block, or a TypeScript statement that declares names. */
interface Item {
  /** `<file>#<name>`; a file's module scope is `<file>#`. */
  readonly id: string
  /** Package-relative path. */
  readonly file: string
  readonly name: string
  readonly kind: string
  /** 1-based, inclusive. */
  readonly line: number
  readonly endLine: number
  readonly doc: string
  /** Rust only: the item's declaration line as rust-analyzer renders it. */
  readonly signature: string
  /** `pub` in Rust; named by an export in TypeScript. */
  readonly exported: boolean
  readonly test: boolean
}

interface FileEntry {
  readonly path: string
  /** The file's header: Rust `//!` module docs, or a TypeScript file's leading `/** *\/` block. */
  readonly doc: string
  readonly lines: number
  readonly test: boolean
}

/** Production code in the package using an item of the same package, `count` times. */
interface Edge {
  readonly from: string
  readonly to: string
  readonly count: number
}

interface PackageIndex {
  readonly package: {
    readonly name: string
    readonly path: string
    readonly language: 'rust' | 'typescript'
    readonly commit: string
    readonly repository: string
  }
  readonly files: FileEntry[]
  readonly items: Item[]
  readonly edges: Edge[]
  /** Item id → references from the package's own tests. */
  readonly testUses: Record<string, number>
  /** Item id → other workspace package → references. */
  readonly externalUses: Record<string, Record<string, number>>
}

/** Accumulates references into a package's index. */
class Uses {
  private readonly internal = new Map<string, number>()
  readonly testUses = new Map<string, number>()
  readonly externalUses = new Map<string, Map<string, number>>()

  internalUse(from: string, to: string): void {
    if (from === to) return
    const k = `${from}\u0000${to}`
    this.internal.set(k, (this.internal.get(k) ?? 0) + 1)
  }
  testUse(to: string): void {
    this.testUses.set(to, (this.testUses.get(to) ?? 0) + 1)
  }
  externalUse(to: string, fromPackage: string): void {
    const m = this.externalUses.get(to) ?? new Map<string, number>()
    m.set(fromPackage, (m.get(fromPackage) ?? 0) + 1)
    this.externalUses.set(to, m)
  }
  edges(): Edge[] {
    return [...this.internal].map(([k, count]) => {
      const [from, to] = k.split('\u0000')
      return { from, to, count }
    })
  }
}

const isTestPath = (rel: string): boolean =>
  /(^|\/)(tests?|__tests__|test-support|testing)\//.test(rel) ||
  /(^|\/)(tests?|test_support|test_util|testing)\.rs$/.test(rel) ||
  /\.(test|spec)\.tsx?$/.test(rel) ||
  /(^|\/)vitest\.[\w.]+$/.test(rel)

const ownerCache = new Map<string, string | undefined>()

/** The repo-relative directory of the workspace package (a `Cargo.toml` or `package.json`) holding a path. */
const owningPackage = (repoRoot: string, path: string): string | undefined => {
  let dir = dirname(path)
  const seen: string[] = []
  while (dir !== '.' && dir !== '/' && dir !== '') {
    if (ownerCache.has(dir)) {
      const hit = ownerCache.get(dir)
      seen.forEach((d) => ownerCache.set(d, hit))
      return hit
    }
    seen.push(dir)
    if (
      existsSync(join(repoRoot, dir, 'Cargo.toml')) ||
      existsSync(join(repoRoot, dir, 'package.json'))
    ) {
      seen.forEach((d) => ownerCache.set(d, dir))
      return dir
    }
    dir = dirname(dir)
  }
  seen.forEach((d) => ownerCache.set(d, undefined))
  return undefined
}

/** The parts of a `package.json` the index reads. */
const PackageJson = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  devDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  peerDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
const readPackageJson = (path: string): typeof PackageJson.Type =>
  Schema.decodeUnknownSync(Schema.parseJson(PackageJson))(readFileSync(path, 'utf8'))

const packageName = (repoRoot: string, pkg: string): string => {
  const cargo = join(repoRoot, pkg, 'Cargo.toml')
  if (existsSync(cargo))
    return readFileSync(cargo, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? pkg
  return readPackageJson(join(repoRoot, pkg, 'package.json')).name ?? pkg
}

const trimDoc = (text: string): string => text.trim().slice(0, 4000)

export type { Edge, FileEntry, Item, PackageIndex }
export { Uses, isTestPath, owningPackage, packageName, readPackageJson, trimDoc }
