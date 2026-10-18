# code-index-web

The code index, to be served at `wildflowerhealth.io/code-index`: one page per
package showing its files and top-level items with their doc comments, which
item uses which, and the places those uses suggest could be simpler.

## What a package page shows

- **Graph.** One node per file, grouped by a colour stripe per top folder; a
  closed folder is one node. Double-click a folder to open it, or a file to
  show its items. Selecting a node colours what it uses (blue) and what uses
  it (orange); _Only the selection's neighbours_ hides the rest.
- **Structure.** The package's folders, files and items, filterable.
- **Detail.** The selection's doc comment (a Rust file's `//!` docs, a
  TypeScript file's leading `/** */` block, or an item's own), its uses and
  users, uses from other workspace packages, and its lines on GitHub.
- **Hints.** Files in a cycle; items nothing references; items only tests
  use; private functions of at most 15 lines with one caller; `pub` Rust items
  no other crate uses; exported items without a doc comment. Uses through
  macros, routers or string names are invisible to the index, so a hint is a
  place to look, not a verdict.

## How the data is made

`scripts/extract.ts` writes one JSON file per package (`model.ts` is its
shape).

- **Rust** comes from rust-analyzer's [SCIP](https://github.com/sourcegraph/scip)
  index of the whole workspace, which carries every definition and reference,
  each definition's span and the doc comments (`rust-scip.ts`). An `impl`
  block has no definition of its own there, so its item spans its members;
  items a macro generates (a `diesel::table!`'s columns) share the macro's
  span and become one item.
- **TypeScript** comes from the TypeScript checker (`typescript-checker.ts`):
  every identifier is resolved to its declaration through aliases, so
  `Client.Schema` reaches the `ClientSchema` a namespace module re-exports,
  and an import through a package's `exports` reaches the source via the
  `source` condition. Uses from other packages come from the programs of the
  workspace packages that depend on it. (scip-typescript records neither of
  those, which is why TypeScript doesn't use SCIP.)

`scripts/build-page.ts` inlines the data into `viewer/template.html`.

```sh
rustup component add rust-analyzer
rust-analyzer scip . --output /tmp/rust.scip          # from the repo root, ~6 min
vp run --filter @wildflowerhealthio/code-index-web extract \
  --repo-root "$PWD" --rust-scip /tmp/rust.scip --out /tmp/code-index \
  --package slices/authorization/authorization-core \
  --package apps/host/wildflower-server/authorization-server-rust
vp run --filter @wildflowerhealthio/code-index-web build-page \
  --data /tmp/code-index --out /tmp/code-index.html
```

A Rust crate needs `scripts/ci/stub-embedded-bundles.sh all` first in a fresh
checkout, so rust-analyzer can build it.

## Status

A spike: the viewer is a single vanilla-JS page that loads ELK from a CDN,
and nothing publishes it yet. Still to do: the viewer in the site's React and
CSS-module conventions, an index of every package, and a `main`-only deploy
to `/code-index/<package>/`.
