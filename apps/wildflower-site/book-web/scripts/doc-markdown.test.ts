import { describe, expect, it } from 'vite-plus/test'

import { renderDocMarkdown } from './doc-markdown.ts'

/** Resolves every destination it knows to `#<destination>`, and the rest nowhere. */
const known =
  (...destinations: readonly string[]) =>
  async (destination: string): Promise<string | undefined> =>
    destinations.includes(destination) ? `#${destination}` : undefined

describe('renderDocMarkdown', () => {
  it('resolves each intra-doc link form, and drops the reference definitions', async () => {
    const rendered = await renderDocMarkdown(
      [
        'Uses [`y`](Self::y), [`B`](crate::a::B), [`C`], [`D`][d],',
        '[`E`] by its definition, and [`f()`](fn@f()).',
        '',
        '[d]: crate::d::D',
        '[`E`]: crate::e::E',
      ].join('\n'),
      {
        headingLevel: 2,
        resolve: known('Self::y', 'crate::a::B', 'C', 'crate::d::D', 'crate::e::E', 'fn@f()'),
      }
    )
    expect(rendered).toBe(
      [
        'Uses [`y`](#Self::y), [`B`](#crate::a::B), [`C`](#C), [`D`](#crate::d::D),',
        '[`E`](#crate::e::E) by its definition, and [`f()`](#fn@f()).',
      ].join('\n')
    )
  })

  it('shows an unresolved link as its text, and leaves URLs, plain brackets and code spans alone', async () => {
    const rendered = await renderDocMarkdown(
      'See [`Gone`](crate::Gone), [`Nope`], [the site](https://example.org/), [0, 1] and `a[`b`]`.',
      { headingLevel: 2, resolve: known() }
    )
    expect(rendered).toBe(
      'See `Gone`, `Nope`, [the site](https://example.org/), [0, 1] and `a[`b`]`.'
    )
  })

  it('resolves a generic link by its path without the generics, and shows text that is no path as code', async () => {
    const rendered = await renderDocMarkdown(
      'Takes [`AsRef<str>`], [`Pass<T>`], [a list](Vec<Option<T>>), [`a + b`] and [`&str`].',
      { headingLevel: 2, resolve: known('Pass') }
    )
    expect(rendered).toBe('Takes `AsRef<str>`, [`Pass<T>`](#Pass), a list, `a + b` and `&str`.')
  })

  it('demotes headings below the given level, at most to six, but not in code blocks', async () => {
    const rendered = await renderDocMarkdown(
      '# Errors\n\nFails.\n\n## Detail\n\n```text\n# not a heading\n```\n\n###### Deep',
      { headingLevel: 4, resolve: known() }
    )
    expect(rendered).toBe(
      '#### Errors\n\nFails.\n\n##### Detail\n\n```text\n# not a heading\n```\n\n###### Deep'
    )
  })

  it('shows a Rust code block as rustdoc does: as Rust, without its hidden lines', async () => {
    const rendered = await renderDocMarkdown('```no_run\n# let hidden = 1;\nlet shown = 2;\n```', {
      headingLevel: 2,
      resolve: known(),
    })
    expect(rendered).toBe('```rust\nlet shown = 2;\n```')
  })
})
