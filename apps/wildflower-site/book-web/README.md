# book-web

The book at `wildflowerhealth.io/book/`: the code read in domain order. Each
part takes one component, opens with a map of who is involved and how the code
is layered, and then follows a story through it, with the source the story
depends on inlined where it does. [mdbook](https://rust-lang.github.io/mdBook/)
renders it, in its stock look: the sidebar, search, and previous and next.

## Where the pages come from

- **The chapters live beside their code**, in a `docs/Book/` folder of the
  package they explain (`apps/host/wildflower-server/authorization-server-rust/docs/Book/`),
  so a change to the code and to its chapter land in the same diff. They are
  Explanation docs, named as the docs are (`Map Explanation.md`).
- **`src/SUMMARY.md` sets the reading order**: a part per component, a
  chapter per page.
- **`src/<part>/<chapter>.md` is a stub** holding one
  `{{#chapter "<path>"}}`, which the build replaces with the chapter's text.
  The stub's path is the page's URL.
- **`src/introduction.md`** says what the book is and how to read its
  excerpts.

## Writing a chapter

A chapter is Markdown with directives that pull source in at build time.
Paths are relative to the repository root, and symbols are resolved by name
within the file, with tree-sitter's Rust grammar for `.rs` files and the
TypeScript parser for `.ts` ones.

```text
{{#code <path> <symbol> [keep-docs] [from="…" [to="…" | through="…"]]…}}
{{#code-link <path> <symbol> [from="…" [to="…" | through="…"]]…}}
```

`{{#code}}` becomes the item's source as a fenced code block, with a line under
it linking those lines on GitHub, at the commit the book was built from, and
the package's page in the [code index](../code-index-web/README.md) (always
production's, since previews have none). `{{#code-link}}` becomes an inline
link to the same lines, labelled with the symbol.

| Symbol (Rust)               | Names                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Item`                      | a `fn`, `struct`, `enum`, `trait`, `const`, `static`, `type`, `union`, macro or `mod` at the top of the file |
| `module::Item`              | the same, inside `mod module { … }`                                                                          |
| `Type::member`              | a `fn`, `const` or `type` in `impl Type` or `impl Trait for Type`, or a `fn` in `trait Type`                 |
| `"<Type as Trait>::member"` | only the one in `impl Trait for Type`; quoted, as it holds spaces                                            |

| Symbol (TypeScript) | Names                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `Name`              | a function, class, interface, type alias, enum, namespace or `const` at the top of the file |
| `Name.member`       | a member of that class or interface, or a declaration in that namespace                     |

A type alias derived from the value of its name (`type Foo = typeof Foo.Type`)
gives way to that value, so `Foo` names the schema.

| Option           | Effect                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `from="text"`    | Start a fragment at the item's first line holding `text` (after the previous fragment).                 |
| `to="text"`      | End it at the first line from there holding `text`.                                                     |
| `through="text"` | End it at that line's statement: the whole statement or expression beginning on it, however many lines. |
| (neither)        | A `from` alone takes the statement beginning on its line.                                               |
| `keep-docs`      | Keep the item's doc comments, which are otherwise left out.                                             |

Several fragments show as one block, with a `// …` line wherever they skip
lines. Doc comments (`///`, `//!`, `/** */`) and attributes (`#[…]`,
decorators) on their own lines are always left out, unless `keep-docs` keeps
the docs; ordinary comments stay. The block is re-indented to the left margin.
Values take `\"` and `\\` escapes.

```text
{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem from="// A concurrent redemption" through="let Some(code)"}}
```

**A directive that can't be resolved fails the build**: a missing file, a
symbol naming nothing or more than one item, or a fragment's text matching no
line. The error names the chapter file and the directive. So a rename that
leaves a chapter behind fails the PR's preview build, not the reader.

Diagrams are ` ```mermaid ` blocks, drawn in the browser by mermaid, which the
build copies out of `node_modules` into the book, so the pages load nothing
from another origin. Only a page with a diagram loads it.

## How it's built

`vp run build-book` (`scripts/build-book.ts`) copies mermaid into
`src/vendor/` and runs `mdbook build`. `book.toml` runs `scripts/code-preprocessor.ts`, an
[mdbook preprocessor](https://rust-lang.github.io/mdBook/for_developers/preprocessors.html)
run by Node, which includes the chapters and expands their directives, so the
build needs mdbook but no Rust toolchain. Links between pages are relative, so
the same build serves `/book/` on the apex and a preview's
`staging/pr-<n>/book/`. mdbook's `404.html` is left out: Pages serves the site
root's.

`.github/workflows/deploy-github-pages.yml` builds it on every push to `main`,
in its `book` job, and the apex deploy publishes it under the marketing site's
build at `/book/`; when the job fails, the apex still deploys, without the
book. `pr-preview.yml` builds it into the marketing site's preview whenever
that previews, which a change to this package or to any file outside every
package (a chapter, the Rust it excerpts) brings about
(`scripts/ci/pages-sites.ts`). Both install mdbook with
`taiki-e/install-action`, pinned to the version below.

It has no `build` script, so `vp run pack` (every package's `build`) never
needs mdbook.

To build it locally, with mdbook 0.5.4:

```sh
cargo install mdbook --version 0.5.4 --locked
# or: the release binary from https://github.com/rust-lang/mdBook/releases/tag/v0.5.4 on PATH
cd apps/wildflower-site/book-web
vp run build-book --out /tmp/site/book
python3 -m http.server -d /tmp/site   # then open /book/
```

`vp test` covers the directive parser and the item finders, against the
sources in `scripts/fixtures/`.
