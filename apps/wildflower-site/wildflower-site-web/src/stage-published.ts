#!/usr/bin/env node
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isWithin } from './assembly.ts'
import { APEX_CUSTOM_DOMAIN, redirectStubHtml, resolvePublishedSites } from './published-sites.ts'

/**
 * Stages the published sites from the assembled one (`dist/`, which
 * `assemble.ts` writes and a PR preview publishes as is) into
 * `dist-published/`:
 *
 * - `apex/` — what this repository's GitHub Pages deploy publishes at
 *   `https://wildflowerhealth.io`: the marketing site, the `404.html`, and a
 *   redirect stub at each old app path (`published-sites.ts`).
 * - `apps/<slug>/` — each hosted app's build, plus the `CNAME` naming its own
 *   origin, `.nojekyll` and `404.html`, which `deploy-github-pages.yml` pushes
 *   to the `gh-pages` branch of `wildflowerhealthio/<slug>-web`. Pages reads
 *   `CNAME` and `.nojekyll` only from the branch root, so each site carries
 *   its own.
 *
 * Runs after the Sentry step, which rewrites the assembled JavaScript and
 * deletes its source maps, so the staged copies are the ones that report.
 * Fails if anything a site needs is missing.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const assembledDir = join(packageRoot, 'dist')
const outDir = join(packageRoot, 'dist-published')
const fourOhFour = join(packageRoot, '404.html')

const log = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

if (!existsSync(join(assembledDir, 'index.html'))) {
  process.stderr.write(
    `No assembled site at ${assembledDir}: run \`vp run pack\` (or this package's build) first.\n`
  )
  process.exit(1)
}

const sites = resolvePublishedSites(assembledDir, outDir)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// The apex: everything assembled but the apps, then a stub at each old path.
cpSync(assembledDir, sites.apexDir, {
  recursive: true,
  filter: (source) => !sites.appDirsInAssembly.some((appDir) => isWithin(appDir, source)),
})
for (const redirect of sites.redirects) {
  mkdirSync(dirname(redirect.stubPath), { recursive: true })
  writeFileSync(redirect.stubPath, redirectStubHtml(redirect.fromPath, redirect.to))
  log(`Redirect ${redirect.fromPath} -> ${redirect.to}`)
}
log(`Staged the apex site at ${sites.apexDir}`)

for (const app of sites.apps) {
  if (!existsSync(join(app.from, 'index.html'))) {
    process.stderr.write(`The assembled site has no build of ${app.app} at ${app.from}\n`)
    process.exit(1)
  }
  cpSync(app.from, app.to, { recursive: true })
  writeFileSync(join(app.to, 'CNAME'), `${app.customDomain}\n`)
  writeFileSync(join(app.to, '.nojekyll'), '')
  copyFileSync(fourOhFour, join(app.to, '404.html'))
  log(`Staged ${app.app} for https://${app.customDomain}/ at ${app.to}`)
}

const required = [
  join(sites.apexDir, 'index.html'),
  join(sites.apexDir, '404.html'),
  join(sites.apexDir, 'CNAME'),
  ...sites.redirects.map((redirect) => redirect.stubPath),
  ...sites.apps.flatMap((app) =>
    ['index.html', '404.html', 'CNAME', '.nojekyll'].map((file) => join(app.to, file))
  ),
]
const missing = required.filter((path) => !existsSync(path))
if (missing.length > 0) {
  process.stderr.write(`The staged sites are missing required files:\n${missing.join('\n')}\n`)
  process.exit(1)
}
const apexCname = readFileSync(join(sites.apexDir, 'CNAME'), 'utf8').trim()
if (apexCname !== APEX_CUSTOM_DOMAIN) {
  process.stderr.write(`The apex CNAME names ${apexCname}, not ${APEX_CUSTOM_DOMAIN}\n`)
  process.exit(1)
}

log(`Staged the published sites at ${outDir}`)
