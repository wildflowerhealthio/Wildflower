#!/usr/bin/env node
// Writes the code index's data: one JSON file per package, holding its files
// and top-level items with their doc comments, and which item uses which,
// plus `packages.json`, the list of them.
//
//   node extract.ts --repo-root <dir> --rust-scip rust.scip --out <dir> --all
//   node extract.ts --repo-root <dir> --rust-scip rust.scip --out <dir> \
//     --package <repo-relative dir> [--package …]
//
// `--all` indexes every Cargo workspace member and every workspace package
// with a `tsconfig.json`. Rust packages come from rust-analyzer's SCIP index
// (rust-scip.ts); TypeScript packages from the TypeScript checker
// (typescript-checker.ts), all scanned together so a use from any of them
// counts for the package it reaches.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { type PackageIndex, packageDescription } from './model.ts'
import { rustIndex } from './rust-scip.ts'
import { typescriptIndex } from './typescript-checker.ts'

const { values: args } = parseArgs({
  options: {
    'repo-root': { type: 'string' },
    'rust-scip': { type: 'string' },
    package: { type: 'string', multiple: true },
    all: { type: 'boolean' },
    out: { type: 'string' },
  },
})
const repoRoot = args['repo-root']!
const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']).toString().trim()
const isRust = (pkg: string): boolean => existsSync(join(repoRoot, pkg, 'Cargo.toml'))

/** Every Cargo workspace member, then every workspace package with a tsconfig. */
const everyPackage = (): string[] => {
  const members =
    readFileSync(join(repoRoot, 'Cargo.toml'), 'utf8').match(
      /^members\s*=\s*\[([\s\S]*?)\]/m
    )?.[1] ?? ''
  const rust = [...members.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const typescript = execFileSync('git', ['-C', repoRoot, 'ls-files', '*package.json'])
    .toString()
    .split('\n')
    .filter((p) => p && p !== 'package.json' && !p.includes('node_modules'))
    .map((p) => dirname(p))
    .filter((d) => existsSync(join(repoRoot, d, 'tsconfig.json')) && !isRust(d))
  return [...rust.toSorted(), ...typescript.toSorted()]
}

const packages = args.all ? everyPackage() : (args.package ?? [])
const indexes: PackageIndex[] = []
const rustPackages = packages.filter(isRust)
if (rustPackages.length) {
  const rust = await rustIndex(args['rust-scip']!, repoRoot, commit)
  for (const pkg of rustPackages) indexes.push(rust(pkg))
}
const typescriptPackages = packages.filter((p) => !isRust(p))
if (typescriptPackages.length)
  indexes.push(...typescriptIndex(repoRoot, commit)(typescriptPackages))

// A page's slug is its package's name, without the npm scope or the crates'
// `wildflowerhealthio-` prefix; a crate that would collide takes `-rust`.
const slugs = new Set<string>()
const slugFor = (index: PackageIndex): string => {
  const base = index.package.name.replace(/^@[^/]+\//, '').replace(/^wildflowerhealthio-/, '')
  let slug = slugs.has(base) && index.package.language === 'rust' ? `${base}-rust` : base
  for (let k = 2; slugs.has(slug); k++) slug = `${base}-${k}`
  slugs.add(slug)
  return slug
}

mkdirSync(args.out!, { recursive: true })
const manifest = indexes
  // TypeScript first, so a TS package keeps the bare slug a crate would share.
  .toSorted((a, b) => Number(a.package.language === 'rust') - Number(b.package.language === 'rust'))
  .map((index) => {
    const slug = slugFor(index)
    writeFileSync(join(args.out!, `${slug}.json`), JSON.stringify(index))
    process.stderr.write(
      `${index.package.name}: ${index.files.length} files, ${index.items.length} items, ${index.edges.length} edges\n`
    )
    return {
      slug,
      name: index.package.name,
      path: index.package.path,
      language: index.package.language,
      description: packageDescription(repoRoot, index.package.path),
      files: index.files.filter((f) => !f.test).length,
      items: index.items.filter((i) => !i.test && i.kind !== 'Module').length,
      edges: index.edges.length,
    }
  })
  .toSorted((a, b) => a.path.localeCompare(b.path))
writeFileSync(
  join(args.out!, 'packages.json'),
  JSON.stringify({ commit, packages: manifest }, null, 2)
)
