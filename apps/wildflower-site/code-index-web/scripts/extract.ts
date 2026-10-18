#!/usr/bin/env node
// Writes the code index's data: one JSON file per package, holding its files
// and top-level items with their doc comments, and which item uses which.
//
//   node extract.ts --repo-root <dir> --rust-scip rust.scip \
//     --package <repo-relative dir> [--package …] --out <dir>
//
// Rust packages come from rust-analyzer's SCIP index (rust-scip.ts);
// TypeScript packages from the TypeScript checker (typescript-checker.ts).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import type { PackageIndex } from './model.ts'
import { rustIndex } from './rust-scip.ts'
import { typescriptIndex } from './typescript-checker.ts'

const { values: args } = parseArgs({
  options: {
    'repo-root': { type: 'string' },
    'rust-scip': { type: 'string' },
    package: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
})
const repoRoot = args['repo-root']!
const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']).toString().trim()

const packages = args.package ?? []
const isRust = (pkg: string): boolean => existsSync(join(repoRoot, pkg, 'Cargo.toml'))

let rust: ((pkg: string) => PackageIndex) | undefined
if (packages.some(isRust)) {
  rust = await rustIndex(args['rust-scip']!, repoRoot, commit)
}
const typescript = typescriptIndex(repoRoot, commit)

mkdirSync(args.out!, { recursive: true })
const manifest: {
  slug: string
  name: string
  path: string
  language: string
  files: number
  items: number
}[] = []
for (const pkg of packages) {
  const started = Date.now()
  const index = isRust(pkg) ? rust!(pkg) : typescript(pkg)
  const slug = index.package.name.replace(/^@[^/]+\//, '')
  writeFileSync(join(args.out!, `${slug}.json`), JSON.stringify(index))
  manifest.push({
    slug,
    name: index.package.name,
    path: pkg,
    language: index.package.language,
    files: index.files.length,
    items: index.items.length,
  })
  process.stderr.write(
    `${index.package.name}: ${index.files.length} files, ${index.items.length} items, ${index.edges.length} edges (${Date.now() - started} ms)\n`
  )
}
writeFileSync(join(args.out!, 'packages.json'), JSON.stringify(manifest, null, 2))
