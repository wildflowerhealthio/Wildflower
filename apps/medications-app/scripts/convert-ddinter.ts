/**
 * Convert DDInter's download CSVs into the compact JSON the app bundles:
 * `vp run -F medications-app data:ddinter -- <dir>` (see the README). Only the
 * file I/O lives here; the conversion is `medication-interaction-core`'s.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildDdinterFile, parseDdinterCsv } from 'medication-interaction-core'

// `vp run … -- <dir>` forwards the `--` separator itself; it is not the directory.
const [dir] = process.argv.slice(2).filter((argument) => argument !== '--')
if (dir === undefined) {
  process.stderr.write(
    'usage: convert-ddinter.ts <directory holding ddinter_downloads_code_*.csv>\n'
  )
  process.exit(2)
}

const csvName = /^ddinter_downloads_code_[A-Za-z]\.csv$/
const files = readdirSync(dir)
  .filter((name) => csvName.test(name))
  .toSorted()
if (files.length === 0) {
  process.stderr.write(`no ddinter_downloads_code_*.csv files in ${dir}\n`)
  process.exit(2)
}

const rows = files.flatMap((name) => parseDdinterCsv(readFileSync(join(dir, name), 'utf8')))
const file = buildDdinterFile(rows, {
  name: 'DDInter',
  url: 'https://ddinter.scbdd.com/',
  retrievedOn: new Date().toISOString().slice(0, 10),
})

const output = resolve(import.meta.dirname, '../src/data/ddinter/ddinter.json')
writeFileSync(output, `${JSON.stringify(file)}\n`)
process.stdout.write(
  `${files.length} file(s), ${rows.length} rows → ${file.drugs.length} drugs, ${file.pairs.length} pairs → ${output}\n`
)
