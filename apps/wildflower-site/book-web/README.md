# book-web

The book at `wildflowerhealth.io/book/`: the code read in domain order. Each
part takes one component and opens with an introduction to who is involved and
how the code is layered. Its domain chapters then give each entity a page,
each item its doc comment, its code and the unit tests that hold it, in the
order the concepts build on each other; its integration-test chapters give each test a
section, saying what the test holds the server to and linking the domain
sections it relies on. [mdbook](https://rust-lang.github.io/mdBook/) renders
it, in its stock look: the sidebar, search, and previous and next.

## Where the pages come from

- **The chapters live beside their code**, in a `docs/Book/` folder of the
  package they explain (`apps/host/wildflower-server/authorization-server-rust/docs/Book/`),
  so a change to the code and to its chapter land in the same diff. They are
  Explanation docs, named as the docs are (`Introduction Explanation.md`,
  `Domain/Grant Explanation.md`).
- **`src/SUMMARY.md` sets the reading order**: a part per component, a
  chapter per page, nested as the chapters' folders are.
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

A `proptest! { … }` block's functions are items of the scope the block is
in, so a property test in `mod tests` is `tests::name`, as a `#[test]` is.

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

Chapters link each other as files in the repository, by relative path, with
angle brackets around a path with spaces
(`[the grant](<../Domain/Grant Explanation.md#covers>)`), so the links work on
GitHub too. The build points each at the page that includes that chapter,
anchor kept, and a relative link to any other file at the file on GitHub.

**A directive that can't be resolved fails the build**: a missing file, a
symbol or test naming nothing or more than one item, a fragment's text
matching no line, or an anchor already on the page. The error names the chapter file and the directive. So a rename that
leaves a chapter behind fails the PR's preview build, not the reader.

Diagrams are ` ```mermaid ` blocks, drawn in the browser by mermaid, which the
build copies out of `node_modules` into the book, so the pages load nothing
from another origin. Only a page with a diagram loads it.

### Items

```text
{{#item <path> <symbol> [tests="<symbol> <symbol>…"] [level=N]}}
```

`{{#item}}` shows a Rust item from its source alone: an anchor, the item's doc
comment as prose, then its source as `{{#code}}` shows it, without the doc
comment, and with the same line under it linking GitHub and the code index. A
struct, enum, union or trait keeps the doc comments of its fields, variants and
methods in the code, so they document themselves. Each test `tests=` names, in
that file, follows in order: its doc comment as a caption, then its code.
Symbols are named as for `{{#code}}`, and `.rs` files alone can be shown.

| Option        | Effect                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `tests="a b"` | Show these tests after the item, each captioned by its doc comment.                                        |
| `level=N`     | Make a doc comment's `#` heading (`# Errors`, `# Panics`) an `N`-deep heading, `##` one deeper, up to six. |
| (no `level=`) | One deeper than the nearest heading above the directive in the chapter, or `##` under none.                |

The doc comment's Markdown is read as rustdoc reads it. A code block without a
language is Rust, and its lines starting `#` and a space are hidden. An intra-doc link
(``[`X`](Self::y)``, ``[`X`](crate::a::B)``, ``[`X`]``, or ``[`X`]`` with a
``[`X`]: crate::…`` definition, whose line is dropped) is read from where the
item sits: `Self`, `self`, `super`, `crate` and the crate's own name, the
file's and its inline modules' `use`s, then the item's module. It goes to,
in order:

1. the `{{#item}}` showing the item it names, on any page of the book;
2. for a bare name nothing in scope brings in, the one `{{#item}}` in the crate
   whose path ends with it;
3. the item where it is defined, following `pub use` re-exports: its
   `{{#item}}`, or else its lines on GitHub;
4. for a field or variant (`Type::field`), its type, as in 3;
5. nowhere: the link's text alone, as inline code.

A path outside the crate (`std::…`, another crate) ends at 5. As rustdoc
does, a path's generic arguments are dropped before it is read
(``[`AsRef<str>`]`` names `AsRef`, ``[`Pass<T>`]`` names `Pass`), and a
bare ``[`X`]`` whose text is no path (``[`&str`]``, ``[`a + b`]``) is its
text alone. Links to URLs stay as written.

Each `{{#item}}` puts `<div id="item-…">` before its prose, so a link can
land on it: `item-`, then the symbol's segments joined by `--`, each with any
character outside `[A-Za-z0-9_]` as `-`.

| Symbol                             | Anchor                              |
| ---------------------------------- | ----------------------------------- |
| `Client`                           | `item-Client`                       |
| `Client::allows_scopes`            | `item-Client--allows_scopes`        |
| `tests::a_test`                    | `item-tests--a_test`                |
| `"<Counter as Resettable>::reset"` | `item-Counter-as-Resettable--reset` |

That plain anchor is kept unless another item shown anywhere in the book has
the same one, as same-named test helpers in different files do
(`tests::at`). Then each of those items is qualified by its file:
`item-<module>--<segments>`, where `<module>` is the file's stem, or its
folder's name for a `mod.rs`. If that still leaves two alike, or lands on
another item's plain anchor, each is qualified by its whole path from the
repository root, without `.rs`, its segments joined by `--`.

| Shown items                                                      | Anchors                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `x/src/grant.rs tests::at` alone                                 | `item-tests--at`                                                                     |
| `x/src/grant.rs tests::at` and `x/src/client/mod.rs tests::at`   | `item-grant--tests--at`, `item-client--tests--at`                                    |
| `x/src/a/started.rs tests::started` and `x/src/b/started.rs` too | `item-x--src--a--started--tests--started`, `item-x--src--b--started--tests--started` |

The same item shown on two pages is one item, with one anchor on each. The
same item twice on one page fails the build. Doc links land on whichever
anchor the item got. A chapter's own link to an item is
`[text](#item-Client--allows_scopes)` on its page, or the other chapter's
file with that anchor.

markdownlint can't see these anchors, as they only exist once the book is
built. The repository's config lets them through: `link-fragments` (MD051)
ignores a fragment starting `item-` (`.markdownlint-cli2.mjs`), and the local
config's `relative-links` rule ignores one in a link to another file
(`.local.markdownlint-cli2.mjs`). It applies repository-wide, as
markdownlint-cli2 can't scope a rule's options to a glob, but only the book's
chapters link to `#item-` anchors.

```text
{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs Client::allows_scopes tests="allows_scopes_tests::allows_scopes_is_coverage_aware"}}
```

## Coverage

A chapter that explains a file says so at its top, and the build checks the
book shows what's in it:

```text
{{#covers <path>}}
{{#covered <path> <symbol>…}}
```

`{{#covers}}` becomes a line linking the file on GitHub. The file's
**coverable items** are its `pub` and `pub(crate)` functions, types, traits,
consts and statics, the `pub` and `pub(crate)` functions and consts of its
inherent `impl` blocks, and every test function (an attribute whose path ends
in `test`: `#[test]`, `#[tokio::test]`), inline modules and `proptest!` blocks
included, so a unit test or a property test is `tests::name`. Only `.rs` files can be covered.

An item is in the book when any `{{#code}}`, `{{#code-link}}` or `{{#item}}`
(as its item or one of its `tests=`) on any page names it, however its symbol
is spelt. `{{#covered}}` renders nothing: it
counts items as in the book without showing them, for what the prose names
another way (getters grouped in a sentence, say). Its symbols must resolve,
as `{{#code}}`'s must.

After expanding every page, the build prints the count and a warning per
coverable item no directive names; then, a list per kind, the coverable
items, tests, named fields and variants (of the coverable structs and enums,
`Type::field`, `Enum::Variant`, `Enum::Variant::field`) with no doc comment;
a tuple's positional fields (`Tuple::0`) aren't listed, as the type's or
variant's own doc comment covers them; then each
test that no `{{#item tests=…}}` or `{{#code}}` shows, which a
`{{#code-link}}` or `{{#covered}}` doesn't. None of it fails the build: the
lists say where the book and the doc comments have fallen behind the code.

```text
coverage: 212/230 items; 18 not in the book:
  WARNING: apps/…/src/domain/grant.rs Grant::covers
undocumented items: 16 without a doc comment:
  WARNING: apps/…/src/config.rs AuthorizationServerConfig
undocumented tests: 203 without a doc comment:
  WARNING: apps/…/src/crypto_util/base64.rs tests::each_variant_round_trips
undocumented fields: 341 without a doc comment:
  WARNING: apps/…/src/db/grant_store.rs SqliteGrantStore::pool
undocumented variants: 34 without a doc comment:
  WARNING: apps/…/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusView::Pending
tests: 640/647 shown; 7 not shown by {{#item tests=…}} or {{#code}}:
  WARNING: apps/…/src/domain/grant.rs tests::covers_a_narrower_scope
```

## How it's built

`vp run build-book` (`scripts/build-book.ts`) copies mermaid into
`src/vendor/` and runs `mdbook build`. `book.toml` runs `scripts/code-preprocessor.ts`, an
[mdbook preprocessor](https://rust-lang.github.io/mdBook/for_developers/preprocessors.html)
run by Node, which includes the chapters, indexes every page's `{{#item}}`s
for doc links to land on, and expands their directives, so the
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

`vp test` covers the directive parser, the item finders, `{{#item}}`'s
anchors, doc comment rendering and link resolution, and the coverage listing, against the
sources in `scripts/fixtures/`.
