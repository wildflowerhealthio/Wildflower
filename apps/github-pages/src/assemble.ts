#!/usr/bin/env node
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { escapingPaths, missingRequiredPaths, resolveSections } from './assembly.ts'

/**
 * Assembles the GitHub Pages site: copies each already-built section (see
 * `assembly.ts` for the layout) into this package's `dist/`. It refuses to
 * write at all if the layout resolves outside `dist/`, and fails loudly
 * afterwards if a section's required files are missing. Filesystem work only —
 * each
 * section is a workspace dependency of this package, so the workspace's
 * topological build (`vp run pack`) has already built it by the time this runs.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(packageRoot, '..', '..')
const outDir = join(packageRoot, 'dist')

const log = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

const sections = resolveSections(repoRoot, outDir)

// Checked before any filesystem write: a layout that resolves outside dist/
// must never get the chance to delete or overwrite anything there.
const escaping = escapingPaths(outDir, sections)

if (escaping.length > 0) {
  process.stderr.write(
    `Site layout resolves outside ${outDir}:\n${escaping.join('\n')}\n` +
      `Fix the destPath/requiredFiles entries in src/assembly.ts.\n`
  )
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const section of sections) {
  if (!existsSync(section.from)) {
    process.stderr.write(
      `Missing build output for ${section.packageName}: ${section.from}\n` +
        `Run \`vp run pack\`, which builds every section before this assembly.\n`
    )
    process.exit(1)
  }
  cpSync(section.from, section.to, { recursive: true })
  log(`Copied ${section.packageName} -> ${section.to}`)
}

// Site-wide files that are not part of any section.
const fourOhFour = join(packageRoot, '404.html')
copyFileSync(fourOhFour, join(outDir, '404.html'))
log(`Copied 404.html -> ${join(outDir, '404.html')}`)

const missing = missingRequiredPaths(sections, (path) => existsSync(path))

if (missing.length > 0) {
  process.stderr.write(`Assembled site is missing required files:\n${missing.join('\n')}\n`)
  process.exit(1)
}

log(`Assembled GitHub Pages site at ${outDir}`)
