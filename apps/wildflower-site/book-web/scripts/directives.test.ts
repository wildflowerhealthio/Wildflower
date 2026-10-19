import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import {
  codeIndexSlug,
  DirectiveError,
  expandDirectives,
  findDirectives,
  includeChapters,
  type LinkTargets,
} from './directives.ts'

/** The fixtures folder stands in for the repository root. */
const repoRoot = join(import.meta.dirname, 'fixtures')

const targets: LinkTargets = {
  repositoryUrl: 'https://github.com/owner/repo',
  commit: 'abc123',
  codeIndexUrl: 'https://example.org/code-index/',
}

describe('findDirectives', () => {
  it('reads the path, symbol, flags and fragments, with quoted text', () => {
    const [quoted] = findDirectives(
      '{{#code a/b.rs "<A as B>::c" keep-docs from="x }} y" to="say \\"hi\\"" from=z}}'
    )
    expect(quoted?.directive).toMatchObject({
      symbol: '<A as B>::c',
      keepDocs: true,
      fragments: [{ from: 'x }} y', end: { kind: 'to', text: 'say "hi"' } }, { from: 'z' }],
    })
  })

  it('refuses an end without its from, an unknown option and an unclosed directive', () => {
    expect(() => findDirectives('{{#code a.rs A to="x"}}')).toThrow(/to= must follow its own from=/)
    expect(() => findDirectives('{{#code a.rs A colour=red}}')).toThrow(/unknown option colour=red/)
    expect(() => findDirectives('{{#code a.rs A\n')).toThrow(DirectiveError)
  })
})

describe('expandDirectives', () => {
  it('renders an excerpt with its GitHub lines and its package in the code index', async () => {
    const { markdown, errors } = await expandDirectives(
      'Intro\n\n{{#code sample-crate/src/lib.rs LIMIT}}\n\nOutro',
      repoRoot,
      targets
    )
    expect(errors).toEqual([])
    expect(markdown).toBe(
      [
        'Intro',
        '',
        '```rust',
        'pub const LIMIT: u32 = 3;',
        '```',
        '',
        '<p class="code-source"><a href="https://github.com/owner/repo/blob/abc123/sample-crate/src/lib.rs#L12"><code>sample-crate/src/lib.rs</code> line 12</a> · <a href="https://example.org/code-index/sample-crate/">sample-crate in the code index</a></p>',
        '',
        'Outro',
      ].join('\n')
    )
  })

  it('renders a link to an item, and a TypeScript excerpt outside any package', async () => {
    const { markdown, errors } = await expandDirectives(
      'See {{#code-link sample-ts/sample.ts twice}}.\n{{#code sample-ts/sample.ts LIMIT}}',
      repoRoot,
      targets
    )
    expect(errors).toEqual([])
    expect(markdown).toContain(
      'See [`twice`](https://github.com/owner/repo/blob/abc123/sample-ts/sample.ts#L29-L31).'
    )
    expect(markdown).toContain('```ts\nconst LIMIT = 3\n```')
    expect(markdown).not.toContain('code index')
  })

  it('reports every directive naming a missing file, symbol or text', async () => {
    const { errors } = await expandDirectives(
      [
        '{{#code sample-crate/src/missing.rs A}}',
        '{{#code sample-crate/src/lib.rs Missing}}',
        '{{#code sample-crate/src/lib.rs Counter::bump from="nowhere"}}',
        '{{#code sample-crate/src/lib.rs Counter::reset}}',
      ].join('\n'),
      repoRoot,
      targets
    )
    expect(errors).toEqual([
      '{{#code sample-crate/src/missing.rs A}}: no file sample-crate/src/missing.rs',
      '{{#code sample-crate/src/lib.rs Missing}}: no Rust item named Missing',
      '{{#code sample-crate/src/lib.rs Counter::bump from="nowhere"}}: from="nowhere" matches no line of the item from line 25 on',
      expect.stringMatching(
        /^\{\{#code sample-crate\/src\/lib.rs Counter::reset\}\}: Counter::reset is ambiguous/
      ),
    ])
  })
})

describe('includeChapters', () => {
  it('replaces a stub with the chapter, and reports a missing one', () => {
    const included = includeChapters('{{#chapter "sample-ts/sample.ts"}}', repoRoot)
    expect(included.markdown).toContain('class Counter {')
    expect(included.included).toEqual(['sample-ts/sample.ts'])
    expect(includeChapters('{{#chapter "nope.md"}}', repoRoot).errors).toEqual([
      '{{#chapter "nope.md"}}: no file nope.md',
    ])
  })
})

describe('codeIndexSlug', () => {
  it('drops the npm scope and the crates’ prefix', () => {
    expect(codeIndexSlug('@wildflowerhealthio/book-web')).toBe('book-web')
    expect(codeIndexSlug('wildflowerhealthio-authorization-server')).toBe('authorization-server')
  })
})
