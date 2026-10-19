import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { coverableItems, coverageReport, formatCoverage } from './coverage.ts'
import { expandDirectives, type LinkTargets } from './directives.ts'

/** The fixtures folder stands in for the repository root. */
const repoRoot = join(import.meta.dirname, 'fixtures')
const path = 'sample-crate/src/covered.rs'
const source = readFileSync(join(repoRoot, path), 'utf8')

const targets: LinkTargets = {
  repositoryUrl: 'https://github.com/owner/repo',
  commit: 'abc123',
  codeIndexUrl: 'https://example.org/code-index/',
}

describe('coverableItems', () => {
  it('lists public items, inherent public methods and every test, property tests too, in file order', async () => {
    const items = await coverableItems(source)
    expect(items.map(({ symbol }) => symbol)).toEqual([
      'Ticket',
      'LIMIT',
      'Ticket::new',
      'Ticket::id',
      'an_integration_style_test',
      'tests::a_ticket_keeps_its_id',
      'tests::an_async_unit_test',
      'tests::a_ticket_keeps_any_id',
    ])
  })
})

describe('coverageReport', () => {
  it('counts the items a directive names, by the row it resolves to', async () => {
    const items = await coverableItems(source)
    const { references, errors, covers } = await expandDirectives(
      [
        `{{#covers ${path}}}`,
        `{{#code ${path} Ticket::new}}`,
        `See {{#code-link ${path} tests::a_ticket_keeps_its_id}}.`,
        `{{#covered ${path} LIMIT Ticket::id tests::a_ticket_keeps_any_id}}`,
      ].join('\n'),
      repoRoot,
      targets
    )
    expect(errors).toEqual([])
    expect(covers).toEqual([path])
    const report = coverageReport([{ path, items }], references)
    expect(report).toEqual({
      total: 8,
      referenced: 5,
      missing: [
        { path, symbol: 'Ticket' },
        { path, symbol: 'an_integration_style_test' },
        { path, symbol: 'tests::an_async_unit_test' },
      ],
    })
    expect(formatCoverage(report)).toBe(
      [
        'coverage: 5/8 items; 3 not in the book:',
        `  WARNING: ${path} Ticket`,
        `  WARNING: ${path} an_integration_style_test`,
        `  WARNING: ${path} tests::an_async_unit_test`,
        '',
      ].join('\n')
    )
  })

  it('says so when every item is in the book', () => {
    expect(formatCoverage({ total: 2, referenced: 2, missing: [] })).toBe(
      'coverage: 2/2 items; every covered item is in the book\n'
    )
  })
})

describe('coverage directives', () => {
  it('renders {{#covers}} as a link to the file and {{#covered}} as nothing', async () => {
    const { markdown, errors } = await expandDirectives(
      `{{#covers ${path}}}\n{{#covered ${path} LIMIT}}`,
      repoRoot,
      targets
    )
    expect(errors).toEqual([])
    expect(markdown).toBe(
      '<p class="code-source">Covers <a href="https://github.com/owner/repo/blob/abc123/sample-crate/src/covered.rs"><code>sample-crate/src/covered.rs</code></a></p>\n'
    )
  })

  it('fails on a missing file or symbol, and on a malformed directive', async () => {
    const { errors } = await expandDirectives(
      [
        '{{#covers sample-crate/src/missing.rs}}',
        `{{#covered ${path} Missing}}`,
        '{{#covers sample-ts/sample.ts}}',
      ].join('\n'),
      repoRoot,
      targets
    )
    expect(errors).toEqual([
      '{{#covers sample-crate/src/missing.rs}}: no file sample-crate/src/missing.rs',
      `{{#covered ${path} Missing}}: no Rust item named Missing`,
      '{{#covers sample-ts/sample.ts}}: only .rs files can be covered',
    ])
    expect((await expandDirectives(`{{#covered ${path}}}`, repoRoot, targets)).errors).toEqual([
      `{{#covered ${path}}}: expected a path and at least one symbol`,
    ])
  })
})
