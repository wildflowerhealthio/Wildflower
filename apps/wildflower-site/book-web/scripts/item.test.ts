import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import {
  assignAnchors,
  expandDirectives,
  findDirectives,
  indexBook,
  itemAnchor,
  type BookIndex,
  type LinkTargets,
} from './directives.ts'
import { linkPaths, rustFileOf, namesInUseTree, type PathScope } from './rust-paths.ts'

/** The fixtures folder stands in for the repository root. */
const repoRoot = join(import.meta.dirname, 'fixtures')
const path = 'sample-crate/src/items.rs'

const targets: LinkTargets = {
  repositoryUrl: 'https://github.com/owner/repo',
  commit: 'abc123',
  codeIndexUrl: 'https://example.org/code-index/',
}

const github = (file: string, lines: string): string =>
  `https://github.com/owner/repo/blob/abc123/sample-crate/src/${file}#${lines}`

const source = (lines: string): string =>
  `<p class="code-source"><a href="${github('items.rs', lines)}"><code>sample-crate/src/items.rs</code> ${lines.replace(/^L(\d+)-L(\d+)$/, 'lines $1–$2')}</a> · <a href="https://example.org/code-index/sample-crate/">sample-crate in the code index</a></p>`

/** `markdown` expanded as the page `part/items.md` of a book whose pages are `pages`. */
const expandOn = async (
  markdown: string,
  pages: Readonly<Record<string, string>> = {}
): Promise<string> => {
  const index: BookIndex = indexBook(
    [
      { page: 'part/items.md', markdown },
      ...Object.entries(pages).map(([page, text]) => ({ page, markdown: text })),
    ],
    repoRoot
  )
  const { markdown: expanded, errors } = await expandDirectives(markdown, repoRoot, targets, {
    page: 'part/items.md',
    index,
  })
  expect(errors).toEqual([])
  return expanded
}

describe('findDirectives', () => {
  it('reads an item’s tests and heading level', () => {
    const [found] = findDirectives(
      `{{#item ${path} Pass::issue tests="tests::a tests::b" level=3}}`
    )
    expect(found?.directive).toEqual({
      kind: 'item',
      raw: `{{#item ${path} Pass::issue tests="tests::a tests::b" level=3}}`,
      path,
      symbol: 'Pass::issue',
      tests: ['tests::a', 'tests::b'],
      level: 3,
    })
  })

  it('refuses an unknown option, an empty tests= and a level outside 1 to 6', () => {
    expect(() => findDirectives(`{{#item ${path} Pass keep-docs}}`)).toThrow(
      /unknown option keep-docs/
    )
    expect(() => findDirectives(`{{#item ${path} Pass tests=""}}`)).toThrow(/tests= is empty/)
    expect(() => findDirectives(`{{#item ${path} Pass level=7}}`)).toThrow(/level= must be 1 to 6/)
  })
})

describe('itemAnchor', () => {
  it('joins the symbol’s segments with --, a trait-qualified one naming its trait', () => {
    expect(itemAnchor('Client::allows_scopes')).toBe('item-Client--allows_scopes')
    expect(itemAnchor('tests::a_test')).toBe('item-tests--a_test')
    expect(itemAnchor('<Counter as crate::Resettable>::reset')).toBe(
      'item-Counter-as-Resettable--reset'
    )
  })
})

describe('assignAnchors', () => {
  it('keeps the plain anchor unless two items share it, then qualifies those by file stem, then by path', () => {
    const anchors = assignAnchors([
      { path: 'c/src/grant.rs', symbol: 'Grant' },
      { path: 'c/src/grant.rs', symbol: 'tests::at' },
      { path: 'c/src/client/mod.rs', symbol: 'tests::at' },
      // The same item twice is one item.
      { path: 'c/src/grant.rs', symbol: 'tests :: at' },
      { path: 'c/src/a/started.rs', symbol: 'tests::started' },
      { path: 'c/src/b/started.rs', symbol: 'tests::started' },
    ])
    expect([...anchors.values()]).toEqual([
      'item-Grant',
      'item-grant--tests--at',
      'item-client--tests--at',
      'item-c--src--a--started--tests--started',
      'item-c--src--b--started--tests--started',
    ])
  })
})

describe('{{#item}}', () => {
  it('renders the anchor, the doc comment as prose, then the source without it, keeping a struct’s field docs', async () => {
    const page = await expandOn(`{{#item ${path} Pass}}`)
    expect(page).toBe(
      [
        '<div id="item-Pass" class="item-anchor"></div>',
        '',
        `A pass to the gate, good for [\`LIMIT\`](${github('lib.rs', 'L12')}) uses.`,
        '',
        `It holds a [\`Ticket\`](${github('covered.rs', 'L4-L6')}), is made by [\`Pass::issue\`](${github('items.rs', 'L45-L48')}) and is checked by`,
        `[\`Self::admits\`](${github('items.rs', 'L51-L53')}). A refusal is a [\`Verdict\`](${github('lib.rs', 'L5-L10')}); \`Missing\` isn't`,
        'anywhere, `Vec` is outside the crate, `quiet` is',
        "another module's, and [the docs](https://example.org/) are a plain link.",
        '',
        '```rust',
        'pub struct Pass {',
        '    /// The ticket it was issued for.',
        '    pub ticket: Ticket,',
        '    /// How many times it has been used.',
        '    uses: u32,',
        '    spare: bool,',
        '}',
        '```',
        '',
        source('L14-L21'),
      ].join('\n')
    )
  })

  it('demotes the doc comment’s headings one below the heading above it, or to level=', async () => {
    const underH3 = await expandOn(`# Page\n\n### Issuing\n\n{{#item ${path} Pass::issue}}`)
    expect(underH3).toContain('\n#### Errors\n')
    expect(underH3).toContain('\n##### Example\n')
    expect(underH3).toContain('```rust\nlet pass = Pass::issue(ticket);\n```')
    const atTop = await expandOn(`{{#item ${path} Pass::issue}}`)
    expect(atTop).toContain('\n## Errors\n')
    const overridden = await expandOn(`### Issuing\n\n{{#item ${path} Pass::issue level=2}}`)
    expect(overridden).toContain('\n## Errors\n')
    // A heading in a code block above isn't one.
    const fenced = await expandOn(
      `## Issuing\n\n\`\`\`text\n# not a heading\n\`\`\`\n\n{{#item ${path} Pass::issue}}`
    )
    expect(fenced).toContain('\n### Errors\n')
  })

  it('interleaves each test after the item, in order, captioned by its doc comment', async () => {
    const page = await expandOn(
      `{{#item ${path} Pass::admits tests="tests::issuing_keeps_the_ticket tests::a_fresh_pass_admits"}}`
    )
    expect(page).toBe(
      [
        '<div id="item-Pass--admits" class="item-anchor"></div>',
        '',
        `Whether it admits its holder: under [\`super::LIMIT\`](${github('lib.rs', 'L12')}) uses.`,
        '',
        '```rust',
        'pub fn admits(&self) -> bool {',
        '    self.uses < crate::LIMIT',
        '}',
        '```',
        '',
        source('L51-L53'),
        '',
        '```rust',
        'fn issuing_keeps_the_ticket() {',
        '    assert_eq!(Pass::issue(Ticket::new(2)).ok().map(|p| p.ticket.id()), Some(2));',
        '}',
        '```',
        '',
        source('L67-L69'),
        '',
        'A fresh pass admits; see [`Pass::admits`](#item-Pass--admits).',
        '',
        '```rust',
        'fn a_fresh_pass_admits() {',
        '    assert!(Pass::issue(Ticket::new(1)).is_ok());',
        '}',
        '```',
        '',
        source('L62-L64'),
      ].join('\n')
    )
  })

  it('counts the item and its tests as shown', async () => {
    const { references } = await expandDirectives(
      `{{#item ${path} Pass::admits tests="tests::a_fresh_pass_admits"}}`,
      repoRoot,
      targets
    )
    expect(references).toEqual([
      { path, row: 50, shown: true },
      { path, row: 61, shown: true },
    ])
  })

  it('fails on a symbol or test naming nothing, a file outside a crate, and two items with one anchor', async () => {
    const { errors } = await expandDirectives(
      [
        `{{#item ${path} Missing}}`,
        `{{#item ${path} Pass tests="tests::missing"}}`,
        '{{#item sample-ts/sample.ts LIMIT}}',
        `{{#item ${path} Gate}}`,
        `{{#item ${path} Gate}}`,
      ].join('\n'),
      repoRoot,
      targets
    )
    expect(errors).toEqual([
      `{{#item ${path} Missing}}: no Rust item named Missing`,
      `{{#item ${path} Pass tests="tests::missing"}}: no Rust item named tests::missing`,
      '{{#item sample-ts/sample.ts LIMIT}}: only .rs files can be shown as items',
      `{{#item ${path} Gate}}: another {{#item}} on this page has the anchor item-Gate`,
    ])
  })
})

describe('{{#item}} anchors', () => {
  it('qualifies same-named items from different files, on one page and across the book', async () => {
    const onePage = await expandOn(
      `{{#item ${path} tests::at}}\n\n{{#item sample-crate/src/covered.rs tests::at}}`
    )
    expect(onePage).toContain('<div id="item-items--tests--at" class="item-anchor"></div>')
    expect(onePage).toContain('<div id="item-covered--tests--at" class="item-anchor"></div>')
    const index = indexBook(
      [
        { page: 'part/items.md', markdown: `{{#item ${path} tests::at}}` },
        { page: 'part/other.md', markdown: '{{#item sample-crate/src/covered.rs tests::at}}' },
        { page: 'part/other.md', markdown: '{{#item sample-crate/src/covered.rs Ticket}}' },
      ],
      repoRoot
    )
    expect(index.map(({ page, anchor }) => `${page}#${anchor}`)).toEqual([
      'part/items.md#item-items--tests--at',
      'part/other.md#item-covered--tests--at',
      'part/other.md#item-Ticket',
    ])
    const { markdown } = await expandDirectives(`{{#item ${path} tests::at}}`, repoRoot, targets, {
      page: 'part/items.md',
      index,
    })
    expect(markdown).toContain('<div id="item-items--tests--at" class="item-anchor"></div>')
  })
})

describe('doc link resolution', () => {
  const linkTo = async (
    symbol: string,
    pages: Readonly<Record<string, string>>,
    label: string
  ): Promise<string | undefined> => {
    const page = await expandOn(`{{#item ${path} ${symbol}}}`, pages)
    return new RegExp(`\\[\`${label}\`\\]\\(([^)]*)\\)`).exec(page)?.[1]
  }

  it('lands on the {{#item}} rendering the item, on this page or another', async () => {
    const pages = {
      'part/sub/other.md': '{{#item sample-crate/src/covered.rs Ticket}}',
      'part/third.md': `{{#item ${path} Pass::admits}}`,
    }
    expect(await linkTo('Pass', pages, 'Ticket')).toBe('sub/other.md#item-Ticket')
    expect(await linkTo('Pass', pages, 'Self::admits')).toBe('third.md#item-Pass--admits')
    const samePage = await expandOn(`{{#item ${path} Pass}}\n\n{{#item ${path} Pass::issue}}`)
    expect(samePage).toContain('[`Pass::issue`](#item-Pass--issue)')
  })

  it('takes the one {{#item}} a bare name ends, when nothing in scope names it', async () => {
    const pages = { 'part/other.md': '{{#item sample-crate/src/covered.rs quiet}}' }
    expect(await linkTo('Pass', pages, 'quiet')).toBe('other.md#item-quiet')
  })

  it('falls back to GitHub, then to the type of a field or variant, then to plain code', async () => {
    expect(await linkTo('Pass', {}, 'Verdict')).toBe(github('lib.rs', 'L5-L10'))
    // Through a re-export to the definition, and so to its {{#item}}.
    expect(await linkTo('Gate', {}, 'Admission')).toBe(github('covered.rs', 'L4-L6'))
    expect(
      await linkTo(
        'Gate',
        { 'part/other.md': '{{#item sample-crate/src/covered.rs Ticket}}' },
        'Admission'
      )
    ).toBe('other.md#item-Ticket')
    expect(await linkTo('Pass::issue', {}, 'Gate::Shut')).toBe(github('items.rs', 'L24-L30'))
    expect(
      await linkTo('Pass::issue', { 'part/gate.md': `{{#item ${path} Gate}}` }, 'Gate::Shut')
    ).toBe('gate.md#item-Gate')
    const page = await expandOn(`{{#item ${path} Pass}}`)
    expect(page).toContain("`Missing` isn't")
    expect(page).toContain('`Vec` is outside the crate')
  })
})

describe('rust paths', () => {
  it('reads a file’s module, and a test crate’s root', () => {
    expect(rustFileOf('c', 'my-crate', 'c/src/lib.rs').module).toEqual([])
    expect(rustFileOf('c', 'my-crate', 'c/src/a/mod.rs').module).toEqual(['a'])
    expect(rustFileOf('c', 'my-crate', 'c/src/a/b.rs')).toEqual({
      crate: {
        key: 'c/src',
        name: 'my_crate',
        rootDir: 'c/src',
        rootFiles: ['c/src/lib.rs', 'c/src/main.rs'],
      },
      module: ['a', 'b'],
    })
    expect(rustFileOf('c', 'my-crate', 'c/tests/flow.rs')).toEqual({
      crate: {
        key: 'c/tests/flow.rs',
        name: 'my_crate',
        rootDir: 'c/tests',
        rootFiles: ['c/tests/flow.rs'],
      },
      module: [],
    })
  })

  it('lists the names a use tree brings in', () => {
    expect(namesInUseTree('crate::a::{B, c::D as E, f::{self, G}, h::*, I as _}')).toEqual([
      { name: 'B', path: ['crate', 'a', 'B'] },
      { name: 'E', path: ['crate', 'a', 'c', 'D'] },
      { name: 'f', path: ['crate', 'a', 'f'] },
      { name: 'G', path: ['crate', 'a', 'f', 'G'] },
    ])
  })

  it('reads a link from where the item sits: Self, super, crate, the crate’s name and imports', () => {
    const scope: PathScope = {
      file: rustFileOf('c', 'my-crate', 'c/src/a/b.rs'),
      symbol: 'tests::t',
      imports: new Map([['tests', [{ name: 'X', path: ['super', 'x', 'X'] }]]]),
    }
    expect(linkPaths('super::Y', scope).candidates).toEqual([['a', 'b', 'Y']])
    expect(linkPaths('my_crate::z::Z', scope).candidates).toEqual([['z', 'Z']])
    expect(linkPaths('X::new()', scope).candidates).toEqual([['a', 'b', 'x', 'X', 'new']])
    expect(linkPaths('W', scope)).toEqual({
      candidates: [
        ['a', 'b', 'tests', 'W'],
        ['a', 'b', 'W'],
      ],
      bare: ['W'],
    })
    expect(linkPaths('Self::m', { ...scope, symbol: 'T::n' }).candidates).toEqual([
      ['a', 'b', 'T', 'm'],
    ])
  })
})
