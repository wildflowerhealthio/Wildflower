# code-index-web

The code index at `wildflowerhealth.io/code-index/`: a page listing every Rust
crate and TypeScript package in the workspace, and a page per package showing
its files and top-level items with their doc comments, which item uses which,
and the places those uses suggest could be simpler.

## What a package page shows

- **Graph.** One node per file, grouped by a colour stripe per top folder; a
  closed folder is one node, and files that use nothing drawn and nothing
  drawn uses sit in a grid below. Double-click a folder to open it, or a file
  to show its items. Selecting a node colours what it uses (blue) and what
  uses it (orange); _Only the selection's neighbours_ hides the rest.
- **Structure.** The package's folders, files and items, filterable.
- **Detail.** The selection's doc comment (a Rust file's `//!` docs, a
  TypeScript file's leading `/** */` block, or an item's own), its uses and
  users, the other packages that use it (linked to their pages), and its
  lines on GitHub.
- **Hints.** Files in a cycle; items nothing references; items only tests
  use; private functions of at most 15 lines with one caller; `pub` Rust items
  no other crate uses; exported items without a doc comment. Uses through
  macros, routers or string names are invisible to the index, so a hint is a
  place to look, not a verdict.

## How it's built

`.github/workflows/deploy-github-pages.yml` builds it on every push to `main`,
in its `code-index` job, and the apex deploy publishes it under the marketing
site's build. PR previews leave it out: indexing needs the Rust toolchain and
takes a few minutes. When the job fails, the apex still deploys, without the
index.

1. `rust-analyzer scip .` indexes the Rust workspace (about 6 min).
2. `scripts/extract.ts --all` writes one JSON file per package (`model.ts` is
   its shape) and `packages.json`, the list of them (about 4 min, under 4 GB).
   - **Rust** comes from that SCIP index (`rust-scip.ts`): every definition
     and reference, each definition's span, and the doc comments. An `impl`
     block has no definition of its own there, so its item spans its members;
     items a macro generates (a `diesel::table!`'s columns) share the macro's
     span and become one item.
   - **TypeScript** comes from the TypeScript checker
     (`typescript-checker.ts`). Each package's program is built once, and
     every identifier is resolved through aliases to its declaration, so
     `Client.Schema` reaches the `ClientSchema` a namespace module re-exports
     and an import through a package's `exports` reaches the source via the
     `source` condition; the use counts for whichever package declares it.
     (scip-typescript records neither, which is why TypeScript doesn't use
     SCIP.)
3. `scripts/build-pages.ts` writes `index.html` from `viewer/index.html`,
   `<slug>/index.html` per package from `viewer/package.html` with its data
   inlined, and copies in ELK and the Atkinson Hyperlegible faces, so the
   pages load nothing from another origin.

To build it locally:

```sh
rustup component add rust-analyzer
./scripts/ci/stub-embedded-bundles.sh all
rust-analyzer scip . --output /tmp/rust.scip
cd apps/wildflower-site/code-index-web
vp run extract --all --repo-root "$(git rev-parse --show-toplevel)" \
  --rust-scip /tmp/rust.scip --out /tmp/code-index-data
vp run build-pages --data /tmp/code-index-data --out /tmp/code-index/code-index
python3 -m http.server -d /tmp/code-index   # then open /code-index/
```

`--package <dir>` (repeatable) in place of `--all` indexes only those
packages; uses from packages left out aren't counted.
