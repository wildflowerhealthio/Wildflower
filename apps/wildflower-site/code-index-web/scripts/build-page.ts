#!/usr/bin/env node
// Inlines extracted package data into the viewer, as one self-contained page.
//
//   node build-page.ts --data <extract out dir> --out <page.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { Schema } from 'effect'

const { values: args } = parseArgs({
  options: { data: { type: 'string' }, out: { type: 'string' } },
})
const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'template.html'),
  'utf8'
)
const manifest = Schema.decodeUnknownSync(
  Schema.parseJson(Schema.Array(Schema.Struct({ slug: Schema.String })))
)(readFileSync(join(args.data!, 'packages.json'), 'utf8'))
// Each package's data goes into the page as it is: only the viewer reads it.
const packages = manifest.map((m) => readFileSync(join(args.data!, `${m.slug}.json`), 'utf8'))
// `</` can't appear inside the inline <script>.
const json = `[${packages.join(',')}]`.replace(/<\//g, '<\\/')
writeFileSync(
  args.out!,
  template.replace('/*DATA*/', () => json)
)
