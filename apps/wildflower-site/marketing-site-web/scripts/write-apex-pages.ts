#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_REDIRECTS } from '../src/app-redirects.ts'

/**
 * The last step of this package's build: writes into `dist/` the apex pages no
 * Vite entry builds, so the apex deploy publishes them with the homepage. A
 * redirect page at each hosted app's apex path (`src/app-redirects.ts`), and
 * the `404.html` every Pages site serves (`branding-core`'s
 * `github-pages/404.html`), which hands a deep link under one of those paths
 * to its redirect page. Fails rather than overwrite a page the Vite build
 * wrote. A page already holding exactly what this script writes is its own
 * output from an earlier run: a cache-hit `vp build` replays into `dist/`
 * without emptying it.
 */

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const writeNew = (file: string, content: string): void => {
  const path = join(distDir, file)
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) {
      process.stdout.write(`Kept ${file}\n`)
      return
    }
    process.stderr.write(`${path} already exists; the build must not write it.\n`)
    process.exit(1)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  process.stdout.write(`Wrote ${file}\n`)
}

if (!existsSync(join(distDir, 'index.html'))) {
  process.stderr.write(`No site build at ${distDir}: run \`vp build\` first.\n`)
  process.exit(1)
}

for (const redirect of APP_REDIRECTS) {
  writeNew(redirect.file, redirect.html)
}

const brandingCore = dirname(
  createRequire(import.meta.url).resolve('@wildflowerhealthio/branding-core/package.json')
)
writeNew('404.html', readFileSync(join(brandingCore, 'github-pages', '404.html'), 'utf8'))
