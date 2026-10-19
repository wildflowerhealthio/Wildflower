#!/usr/bin/env node
// Builds the book: copies mermaid in from node_modules (book.toml's
// `additional-js` names it), then runs `mdbook build`, whose `code`
// preprocessor expands the chapters' directives.
//
//   build-book.ts [--out <dir>]   default: book/ in this package
//
// mdbook must be on PATH (README.md, "Building it locally"). The `404.html`
// mdbook writes is left out: GitHub Pages serves only the site root's, and
// mdbook's resolves its assets from `/`, which a preview's subpath breaks.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const { values } = parseArgs({ options: { out: { type: 'string' } } })
const out = resolve(values.out ?? join(packageRoot, 'book'))

mkdirSync(join(packageRoot, 'vendor'), { recursive: true })
copyFileSync(
  require.resolve('mermaid/dist/mermaid.min.js'),
  join(packageRoot, 'vendor', 'mermaid.min.js')
)

const mdbook = spawnSync('mdbook', ['build', '--dest-dir', out], {
  cwd: packageRoot,
  stdio: 'inherit',
})
if (mdbook.error) {
  process.stderr.write(
    `Could not run mdbook (${mdbook.error.message}); see README.md to install it.\n`
  )
  process.exit(1)
}
if (mdbook.status !== 0) process.exit(mdbook.status ?? 1)
rmSync(join(out, '404.html'), { force: true })
process.stdout.write(`Built the book into ${out}\n`)
