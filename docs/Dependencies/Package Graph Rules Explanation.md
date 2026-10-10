# Package Graph Rules Explanation

The workspace's packages depend on one another in two languages: TS packages
through `package.json`, Rust crates through `Cargo.toml`. Three rules hold that
graph in shape, and `scripts/package-graph.test.ts` checks all three on every
`vp test`. This doc explains what the rules are, why they are checked against
the manifests rather than the source, and what each exception is for.

## The rules

**A core never depends on an adapter.** A package named `<name>-core`, or an
app's `<product>-core-js`, is the pure layer (see
[slices/AGENTS.md](../../slices/AGENTS.md)). It may not depend on a package
named for a platform (`-react`, `-tauri`, `-tauri-js`, `-node` or `-web`) or
on a Rust crate. Crates are named `wildflowerhealthio-<folder>`, without the
folder's `-rust` suffix, so the check tells them by their ecosystem: every
crate is a slice's native half, an adapter. A package that needs one, as
`lifelabs-pdf-importer` needs `positioned-text-web`'s pdfjs extraction, is not
a core and doesn't take the suffix.

A core's own code is held pure the same way, below the package level. Each
core's tsconfig has `lib: ["es2024"]` with no `"dom"`, so a `document` or
`window` reference fails to compile. Its `types` keep `node`, because Node's
types are also where the web globals every runtime shares (`URL`,
`TextEncoder`, `crypto`) are declared; an import of a Node built-in from a
core's production source is an oxlint error instead (`import/no-nodejs-modules`,
in `vite.config.ts`). Tests and test helpers may use both.

**An app's folder is private to it.** A package inside `apps/<name>/` may be
depended on only by packages in the same folder. Slices and `global/` never
depend on `apps/`. Anything two products use lives in `slices/` or `global/`;
[apps/AGENTS.md](../../apps/AGENTS.md#what-folds-in) says what folds into an
app's folder in the first place.

**No dependency cycles**, in either language.

## Why the manifests

The rules are about packages, and every package already declares its edges.
Reading `package.json` and `Cargo.toml` gives the whole graph without parsing
a line of source, in milliseconds, with no build and no Rust toolchain. The
Cargo manifests are read as TOML (`smol-toml`) rather than through
`cargo metadata`, so the check runs in the TypeScript CI job.

For Rust the manifest graph is the import graph: cargo refuses to compile a
`use` of a crate the manifest doesn't declare. TypeScript has no such guard:
`nodeLinker: hoisted` lets a package import something it never declared and
still resolve. `vp run lint:deps` closes that gap. It runs knip over every
workspace package and fails on an import its manifest doesn't list, so the
manifests the graph is read from stay true; CI runs it beside `vp check`. A
file-path reference that crosses into another package's folder, such as an
`include_str!` of another package's build output, is not an edge either check
sees.

The TS graph comes from `scripts/risk-map.ts`'s workspace reader, which
`vp run test:changed` uses too, so the two never disagree about which
packages exist. An edge counts only when it names a workspace package (a
`workspace:` spec, or a Cargo path dependency).

## The exceptions, and why

- **A dev-dependency from one app to another is allowed.** An app's tests may
  run against another app's real code, as the host's `wildflowerhealthio-servers`
  enrols against the real `wildflowerhealthio-relay-server`. A slice or
  `global/` package gets no such pass, even from its tests: a test that drives
  a slice together with a host crate belongs in the host's own tests.
- **`wildflower-site-web` may depend on other apps' `-web` packages.** It is
  the assembly that copies every app's build to its section of
  wildflowerhealth.io, so it depends on all of them by design.
- **A package that depends on itself is not a cycle.** A crate lists itself
  as a dev-dependency to turn on its own test-only features
  (`wildflowerhealthio-wildflower-server`'s `test-support`), and a TS package
  may do the same to import itself by name in tests.

Every dependency kind counts toward cycles and the core rule; dev-dependencies
are exempt only from the app-privacy rule, and only between apps.

## When the check fails

Each failure names the rule and both packages. The fix is to move code, not
to add an exception:

- A core that needs an adapter either takes the capability as a parameter, or
  isn't a core and drops the suffix.
- A package outside an app that needs something inside it means that
  something is shared: move it to `slices/` (or `global/`), as
  `fhir-sync-pebble-core` moved so the Synthetic Data Loader's generator could
  write through it.
- A cycle means one of the two packages holds what both need: split it out
  below them.

The exceptions live in code beside the rules, in `scripts/package-graph.ts`,
so adding one shows up in review.

## Related

- [slices/AGENTS.md](../../slices/AGENTS.md) — the slice layering these rules
  enforce
- [apps/AGENTS.md](../../apps/AGENTS.md) — product folders and what folds into them
- [Version Override Explanation](./Version%20Override%20Explanation.md) — the
  other workspace-wide dependency constraints
