#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { matchesPin, parsePrebuiltConfig, renderStubPage, sha256Hex } from './prebuilt.ts'

/**
 * Builds this package's `dist/`: the prebuilt OHIF viewer that `prebuilt.json`
 * pins, verified against its SHA-256 and extracted, with `config/app-config.js`
 * laid over the archive's own copy so the published viewer runs Wildflower's
 * runtime configuration. With no release pinned it writes the stub page from
 * `renderStubPage` instead, so `vp run pack` and the site assembly stay green.
 *
 * Filesystem, network and `tar` only — the decisions (what a valid pin is,
 * whether the bytes match, what the stub says) live in `prebuilt.ts` where they
 * are unit-tested.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pinPath = join(packageRoot, 'prebuilt.json')
const appConfigPath = join(packageRoot, 'config', 'app-config.js')
const distDir = join(packageRoot, 'dist')

const log = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const pin = parsePrebuiltConfig(JSON.parse(readFileSync(pinPath, 'utf8')))

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

if (pin === null) {
  writeFileSync(join(distDir, 'index.html'), renderStubPage('apps/ohif-viewer/prebuilt.json'))
  log(`No prebuilt OHIF viewer pinned in ${pinPath}; wrote the stub page to ${distDir}`)
  process.exit(0)
}

log(`Downloading ${pin.url}`)
let archive: Uint8Array
try {
  const response = await fetch(pin.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  archive = new Uint8Array(await response.arrayBuffer())
} catch (error: unknown) {
  const reason = error instanceof Error ? error.message : String(error)
  log(`Download failed (${reason}); writing the stub page instead`)
  writeFileSync(join(distDir, 'index.html'), renderStubPage('apps/ohif-viewer/prebuilt.json'))
  process.exit(0)
}

if (!matchesPin(pin, archive)) {
  fail(
    `Archive digest mismatch for ${pin.url}\n` +
      `  expected ${pin.sha256}\n` +
      `  actual   ${sha256Hex(archive)}\n` +
      `Update prebuilt.json to the release's published sha256, or re-check the URL.`
  )
}

const archivePath = join(packageRoot, 'ohif-viewer.tar.gz')
writeFileSync(archivePath, archive)
try {
  // The release archives `dist/` with its contents at the root, so no
  // --strip-components. GNU and BSD tar both refuse absolute and `..` members.
  execFileSync('tar', ['-xzf', archivePath, '-C', distDir], { stdio: 'inherit' })
} finally {
  rmSync(archivePath, { force: true })
}

if (!existsSync(join(distDir, 'index.html'))) {
  fail(`The archive from ${pin.url} did not contain index.html at its root`)
}

// The archive ships the build's own app-config.js (the dist repo's standalone
// config); Wildflower's replaces it, which is the whole reason config changes
// need no rebuild upstream.
writeFileSync(join(distDir, 'app-config.js'), readFileSync(appConfigPath, 'utf8'))
log(`Built the OHIF viewer into ${distDir} from ${pin.url}`)
