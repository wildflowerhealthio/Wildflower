import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { coverableFile, coverageReport, formatCoverage } from './coverage.ts'
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

describe('coverableFile', () => {
  it('lists public items, inherent public methods and every test, property tests too, in file order', async () => {
    const { items } = await coverableFile(source)
    expect(items.map(({ symbol }) => symbol)).toEqual([
      'Ticket',
      'LIMIT',
      'Ticket::new',
      'Ticket::id',
      'Stage',
      'an_integration_style_test',
      'tests::a_ticket_keeps_its_id',
      'tests::an_async_unit_test',
      'tests::a_ticket_keeps_any_id',
    ])
    expect(items.filter((item) => item.isTest).map(({ symbol }) => symbol)).toEqual([
      'an_integration_style_test',
      'tests::a_ticket_keeps_its_id',
      'tests::an_async_unit_test',
      'tests::a_ticket_keeps_any_id',
    ])
  })

  it('says which items, named fields and variants have a doc comment, leaving out a tuple’s positional fields', async () => {
    const { items, members } = await coverableFile(source)
    expect(items.filter((item) => item.documented).map(({ symbol }) => symbol)).toEqual([
      'Ticket',
      'Stage',
      'tests::a_ticket_keeps_any_id',
    ])
    expect(members).toEqual([
      { symbol: 'Ticket::id', kind: 'field', documented: false },
      { symbol: 'Stage::Issued', kind: 'variant', documented: true },
      { symbol: 'Stage::Used', kind: 'variant', documented: false },
    ])
  })
})

describe('coverageReport', () => {
  it('counts the items a directive names, by the row it resolves to', async () => {
    const coverable = await coverableFile(source)
    const { references, errors, covers } = await expandDirectives(
      [
        `{{#covers ${path}}}`,
        `{{#code ${path} Ticket::new}}`,
        `See {{#code-link ${path} tests::a_ticket_keeps_its_id}}.`,
        `{{#covered ${path} LIMIT Ticket::id Stage tests::a_ticket_keeps_any_id}}`,
      ].join('\n'),
      repoRoot,
      targets
    )
    expect(errors).toEqual([])
    expect(covers).toEqual([path])
    const report = coverageReport([{ path, ...coverable }], references)
    expect(report).toMatchObject({
      total: 9,
      referenced: 6,
      missing: [
        { path, symbol: 'Ticket' },
        { path, symbol: 'an_integration_style_test' },
        { path, symbol: 'tests::an_async_unit_test' },
      ],
    })
  })

  it('lists the items, tests, fields and variants with no doc comment', async () => {
    const report = coverageReport([{ path, ...(await coverableFile(source)) }], [])
    expect(report.undocumented).toEqual([
      { path, symbol: 'LIMIT', kind: 'item' },
      { path, symbol: 'Ticket::new', kind: 'item' },
      { path, symbol: 'Ticket::id', kind: 'item' },
      { path, symbol: 'an_integration_style_test', kind: 'test' },
      { path, symbol: 'tests::a_ticket_keeps_its_id', kind: 'test' },
      { path, symbol: 'tests::an_async_unit_test', kind: 'test' },
      { path, symbol: 'Ticket::id', kind: 'field' },
      { path, symbol: 'Stage::Used', kind: 'variant' },
    ])
  })

  it('lists the tests no {{#item tests=…}} or {{#code}} shows, a link or {{#covered}} not counting', async () => {
    const coverable = await coverableFile(source)
    const { references, errors } = await expandDirectives(
      [
        `{{#code ${path} tests::a_ticket_keeps_its_id}}`,
        `{{#code-link ${path} an_integration_style_test}}`,
        `{{#covered ${path} tests::an_async_unit_test}}`,
        `{{#item ${path} Ticket tests="tests::a_ticket_keeps_any_id"}}`,
      ].join('\n'),
      repoRoot,
      targets
    )
    expect(errors).toEqual([])
    const report = coverageReport([{ path, ...coverable }], references)
    expect({ tests: report.tests, unshownTests: report.unshownTests }).toEqual({
      tests: 4,
      unshownTests: [
        { path, symbol: 'an_integration_style_test' },
        { path, symbol: 'tests::an_async_unit_test' },
      ],
    })
    expect(formatCoverage(report)).toBe(
      [
        'coverage: 5/9 items; 4 not in the book:',
        `  WARNING: ${path} LIMIT`,
        `  WARNING: ${path} Ticket::new`,
        `  WARNING: ${path} Ticket::id`,
        `  WARNING: ${path} Stage`,
        'undocumented items: 3 without a doc comment:',
        `  WARNING: ${path} LIMIT`,
        `  WARNING: ${path} Ticket::new`,
        `  WARNING: ${path} Ticket::id`,
        'undocumented tests: 3 without a doc comment:',
        `  WARNING: ${path} an_integration_style_test`,
        `  WARNING: ${path} tests::a_ticket_keeps_its_id`,
        `  WARNING: ${path} tests::an_async_unit_test`,
        'undocumented fields: 1 without a doc comment:',
        `  WARNING: ${path} Ticket::id`,
        'undocumented variants: 1 without a doc comment:',
        `  WARNING: ${path} Stage::Used`,
        'tests: 2/4 shown; 2 not shown by {{#item tests=…}} or {{#code}}:',
        `  WARNING: ${path} an_integration_style_test`,
        `  WARNING: ${path} tests::an_async_unit_test`,
        '',
      ].join('\n')
    )
  })

  it('lists a file with no //! doc of its own as an undocumented module', async () => {
    const bare = await coverableFile('/// An item, but no module doc.\npub const N: u32 = 1;\n')
    expect(bare.moduleDocumented).toBe(false)
    expect((await coverableFile(source)).moduleDocumented).toBe(true)
    const report = coverageReport([{ path: 'bare.rs', ...bare }], [])
    expect(report.undocumented).toEqual([{ path: 'bare.rs', symbol: 'self', kind: 'module' }])
    expect(formatCoverage(report)).toContain(
      'undocumented modules: 1 without a doc comment:\n  WARNING: bare.rs self\n'
    )
  })

  it('says so when every item and test is in the book and documented', () => {
    expect(
      formatCoverage({
        total: 2,
        referenced: 2,
        missing: [],
        undocumented: [],
        tests: 1,
        unshownTests: [],
      })
    ).toBe(
      'coverage: 2/2 items; every covered item is in the book\ntests: 1/1 shown; every covered test is in the book\n'
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
