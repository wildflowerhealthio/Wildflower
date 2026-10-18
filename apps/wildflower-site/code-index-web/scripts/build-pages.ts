#!/usr/bin/env node
// Builds the code index's pages from extract.ts's data: `index.html`, the
// list of packages, and `<slug>/index.html` for each, with the package's data
// inlined. ELK and the Atkinson Hyperlegible faces are copied in beside them,
// so the pages load nothing from another origin.
//
//   node build-pages.ts --data <extract out dir> --out <dir>
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { Schema } from 'effect'

const { values: args } = parseArgs({
  options: { data: { type: 'string' }, out: { type: 'string' } },
})
const viewer = join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer')
const require = createRequire(import.meta.url)

const Manifest = Schema.Struct({
  commit: Schema.String,
  packages: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      path: Schema.String,
      language: Schema.String,
      description: Schema.String,
      files: Schema.Number,
      items: Schema.Number,
      edges: Schema.Number,
    })
  ),
})
const manifest = Schema.decodeUnknownSync(Schema.parseJson(Manifest))(
  readFileSync(join(args.data!, 'packages.json'), 'utf8')
)

/** JSON for an inline `<script>`, where `</` can't appear. */
const inlineJson = (json: string): string => json.replace(/<\//g, '<\\/')
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

const out = args.out!
mkdirSync(out, { recursive: true })

// Shared assets, once at the root.
cpSync(require.resolve('elkjs/lib/elk.bundled.js'), join(out, 'elk.bundled.js'))
for (const [face, dir] of [
  ['@fontsource-variable/atkinson-hyperlegible-next', 'next'],
  ['@fontsource-variable/atkinson-hyperlegible-mono', 'mono'],
] as const) {
  const from = dirname(require.resolve(`${face}/package.json`))
  cpSync(join(from, 'wght.css'), join(out, 'fonts', dir, 'wght.css'))
  cpSync(join(from, 'files'), join(out, 'fonts', dir, 'files'), {
    recursive: true,
    filter: (f) => !f.endsWith('.woff'),
  })
}

// Every page can link to every other package's page.
const directory = JSON.stringify(
  manifest.packages.map(({ slug, name, path }) => ({ slug, name, path }))
)
const packageTemplate = readFileSync(join(viewer, 'package.html'), 'utf8')
for (const pkg of manifest.packages) {
  const data = readFileSync(join(args.data!, `${pkg.slug}.json`), 'utf8')
  const page = packageTemplate
    .replace('{{TITLE}}', () => escapeHtml(pkg.name))
    .replace('/*DATA*/', () => inlineJson(`{"package":${data},"packages":${directory}}`))
  mkdirSync(join(out, pkg.slug), { recursive: true })
  writeFileSync(join(out, pkg.slug, 'index.html'), page)
}
writeFileSync(
  join(out, 'index.html'),
  readFileSync(join(viewer, 'index.html'), 'utf8').replace('/*DATA*/', () =>
    inlineJson(JSON.stringify(manifest))
  )
)
