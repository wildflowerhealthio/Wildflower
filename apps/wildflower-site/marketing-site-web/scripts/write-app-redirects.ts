#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_REDIRECTS } from '../src/app-redirects.ts'

/**
 * The last step of this package's build: writes a redirect page into `dist/`
 * at each hosted app's old path on the apex (`src/app-redirects.ts`), so the
 * apex deploy publishes them with the homepage. Fails rather than overwrite a
 * page the Vite build wrote there.
 */

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

if (!existsSync(join(distDir, 'index.html'))) {
  process.stderr.write(`No site build at ${distDir}: run \`vp build\` first.\n`)
  process.exit(1)
}

for (const redirect of APP_REDIRECTS) {
  const page = join(distDir, redirect.file)
  if (existsSync(page)) {
    process.stderr.write(`${page} already exists; the ${redirect.app} redirect would replace it.\n`)
    process.exit(1)
  }
  mkdirSync(dirname(page), { recursive: true })
  writeFileSync(page, redirect.html)
  process.stdout.write(`Redirect ${redirect.file} -> ${redirect.app}\n`)
}
