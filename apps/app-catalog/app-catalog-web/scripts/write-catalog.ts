#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The last step of this package's build: copies the catalog Vite copied from
 * `public/apps.json` to `dist/apps`, the path HALO names. Both names carry the
 * same bytes: GitHub Pages picks a file's content type from its extension, so
 * `/apps` is served as `application/octet-stream` and `/apps.json` as
 * `application/json`. `public/` cannot hold the second name without a second
 * committed copy of the catalog.
 */

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const catalogJson = join(distDir, 'apps.json')

if (!existsSync(catalogJson)) {
  process.stderr.write(`No catalog at ${catalogJson}: run \`vp build\` first.\n`)
  process.exit(1)
}

copyFileSync(catalogJson, join(distDir, 'apps'))
process.stdout.write('Wrote apps\n')
