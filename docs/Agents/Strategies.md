# Agent Strategies

Hard-won lessons from agents working in this codebase. Read this at the start of a session if you're picking up in-progress work or tackling a large task.

Agents SHOULD NOT edit this file directly. Record new learnings in the [Learnings Inbox](./Learnings%20Inbox.md) instead — the human promotes entries here during periodic review.

## Context is your scarcest resource

You have a fixed context window. Everything you read, every tool output, every exploration result — it all counts. Plan your context budget like you'd plan a memory budget in an embedded system.

### Exploration discipline

- **Read 2-3 representative files, not 30.** For a mechanical refactor, one example of the pattern is enough. You don't need an exhaustive inventory before you start.
- **Explore agents return massive outputs.** Each one can eat 5-10% of your context. Use them surgically — ask for specific things, not "tell me everything about this package."
- **Don't explore what you can infer.** If you've seen `LocationFromFhirR4` and `PatientFromFhirR4`, you can safely assume `EncounterFromFhirR4` follows the same pattern without reading it.

### Planning vs doing

- **Mechanical refactors**: understand the pattern from examples, then execute. Don't over-plan.
- **Architectural decisions**: plan thoroughly. The cost of getting it wrong is high.
- **The smell test**: if you're reading the 5th file and learning nothing new, stop exploring and start doing.

### Document failure modes, not just the happy path

The pattern section of a handoff doc should include _when the pattern breaks_, not just how it works. "Drop explicit type annotations" is incomplete — "Drop explicit type annotations — _unless_ the const has circular inference, in which case extract to a separate const with an annotation" is what the next agent actually needs.

If you discover a gotcha mid-execution, **update the TODO.md immediately** — don't wait for a cleanup pass. The next agent (or the user) may pick up before you get to it.

### Generate file lists from grep, not from memory

Don't enumerate files to refactor by hand — you'll miss some. Use `grep` or `glob` to find all matches of the pattern you're changing (e.g., `grep -r 'FromFhirR4' src/`), then turn the results into your file list. The Range.ts miss in this refactor is a textbook example.

### Keep the plan current as execution diverges

In multi-session refactors, execution plan sections in TODO.md become stale as implementation diverges from the plan (renamed functions, changed approaches, deleted files). At each phase completion, update or replace plan sections with "what was actually built" summaries. Also update file reference tables — stale entries (e.g., listing files as "DELETE in Phase X" that are already deleted) mislead the next agent.

### Reference files that actually exist

If you reference another doc (e.g., a plan file), make sure it still exists. Dead links waste the next agent's time. If a plan has been superseded by the TODO.md, say so explicitly rather than linking to a ghost.

## Delegate mechanical bulk work

Once a pattern is clear and proven on 2-3 files, use Task agents to apply it to batches. This keeps the mechanical grinding out of your main context window.

Good candidates for delegation:

- Applying the same rename/restructure across 10+ files
- Updating import references after a rename
- Creating mirrored file structures (copying schemas to a new package)

Bad candidates (keep in main context):

- Files with unique structure or special cases
- Anything requiring judgment calls about the design

## Circular imports in Vite SSR

### `Schema.suspend` does not prevent circular module loading

`Schema.suspend(() => X)` defers schema _evaluation_ but does NOT prevent module _loading_. In Vite SSR, `import { X } from './X'` eagerly triggers the module to load. If module A imports B and B imports A, Vite snapshots A's exports (which are `undefined`) before A finishes executing. Even though the `Schema.suspend` callback runs later, any code that calls `A.Foo()` at class-definition time (outside `Schema.suspend`) will crash with `TypeError: Foo is not a function`. The fix is to restructure so no import chain leads back to the originating module — co-locate circular types in one file or eliminate the cycle entirely.

### Circular dependency chains are often transitive

When debugging circular import errors, the cycle is often not between the two files you expect. A 4-hop chain (A -> B -> C -> D -> A) produces errors in D that look like A is undefined. Read Vite's stack trace bottom-to-top to trace the actual module loading chain. Break the cycle at the root cause, not at intermediate links.

## Effect Schema gotchas

### `.Type` and `.Encoded` on Schema.Class are phantom types

`.Type` and `.Encoded` on Effect `Schema.Class` exist only in TypeScript's type system — they are `undefined` at runtime. Tests must use type-level assertions: `expectTypeOf<(typeof MyClass)['Type']['field']>()` — NOT `expectTypeOf(MyClass.Type.field)`, which crashes with `Cannot read properties of undefined`.

### Arbitrary generation on recursive schemas can explode

`Arbitrary.make()` on schemas with recursive fields (e.g., `extension` arrays via `Schema.suspend`) generates deeply nested structures with many optional fields, causing test timeouts. Fix: annotate the recursive array field with `{ arbitrary: () => (fc) => fc.constant([]) }` so property tests generate empty arrays by default. Place the annotation on the base field definition so all subclasses inherit it automatically.

### Schema.Class instances cannot be reconstructed via Object.create + Object.assign

Effect's `Schema.Class` instances carry internal state from `Data.Class` (hash codes, `_tag`, structural equality metadata). Reconstructing via `Object.create(proto) + Object.assign(result, fields)` produces objects that pass `instanceof` but fail during `Schema.encode`. When you need a modified copy, either mutate in-place (if not frozen) or do a Schema encode -> modify -> decode round-trip through the plain encoded representation.

## Recursive object walkers

When recursively walking Effect Schema-generated values, native built-in objects (`URL`, `Date`, `ReadonlyUrl`, etc.) look like plain objects to `typeof v === 'object'` checks. If walked and reconstructed, they lose their prototypes and fail during encoding. Always add explicit guards (`if (v instanceof URL) return v`) for non-POJO built-in types that might appear in the schema tree.

## Environment & toolchain

### Run `vp test` through the workspace-local `vp` in web sessions

Claude-on-the-web containers bootstrap a _global_ `vp` (`pnpm install -g vite-plus`, unpinned) that differs from the workspace's pinned `vite-plus`. `vp check`/`vp build` work under the global one, but `vp test` for a `jsdom` package fails with `Cannot find package 'jsdom'` — the global vp's bundled vitest resolves test-env deps from the global store, where workspace deps don't exist. Run tests via `node_modules/.bin/vp test` (put `<repo>/node_modules/.bin` first on PATH). Run `vp install` after editing any `package.json` so the lockfile and per-package `node_modules` links exist.

### `vp pack` self-reference imports need `platform: 'neutral'`

A package can `import { x } from 'self-name/subpath'` inside its own `src` and `vp pack` with `platform: 'neutral'` + `exports: false` keeps it external at bundle time — Node's self-reference resolution handles it at runtime via the package's own `exports` map. The "Could not resolve" pack warning is expected; don't "fix" it with a relative `../dist/*` path, which breaks once the package is published or re-bundled.

### One config can hold both a Vite app build and `vp pack` entries

A single `defineConfig({...})` can carry a Vite app config (`plugins`, `build.outDir`) _and_ a `pack` config (`pack.entry`, `pack.platform`) because they emit different filenames. Drive both with `"build": "vp run build:html && vp run build:lib"` (html = `vp build`, lib = `vp pack`). Ordering matters when the pack entries import from the html-emitted module.

### `vp check --fix` can mangle complex multi-line types

`vp check --fix` has stripped a member from a multi-line discriminated-union type alias and inlined an oxlint-disable comment where it no longer applied. `vp fmt` alone is safer for formatting; reserve `--fix` for narrow, recently-edited files you can diff carefully afterward.

### Cross-package `tsconfig.json` includes silently break `vp pack` dts

An `include`/`files`/`references` entry pointing at a _sibling_ package's file (a `..` path) widens the TypeScript program to span both directories; with `vp pack`'s `dts.tsgo`, tsgo then emits stray `.d.ts` into the sibling's dist. Sibling tsconfigs already cover their own `tests/`, so cross-includes are wrong and redundant. When chasing "where are these stray `.d.ts` coming from," grep workspace `tsconfig.json` include/files/references arrays for `..` paths.

## Git workflows

### `git stash push` skips untracked files by default

For a true clean baseline (e.g. to confirm whether errors pre-exist), use `git stash push --include-untracked` — a plain `git stash push -- <path>` leaves untracked files in place.

### Drop a squash-merged predecessor commit with `git rebase --onto`

When a feature branch's predecessor already landed on `main` as a squash-merge, `git rebase main branch` re-applies it and conflicts against the (often improved) merged version. Use `git rebase --onto origin/main <commit-to-drop> <branch>` to replay only the commits _after_ the dropped one onto `origin/main`.

### `pnpm-lock.yaml` conflicts: take one side, then `vp install`

Never hand-merge the lockfile — it's a derived artifact. Run `git checkout --ours pnpm-lock.yaml && git add pnpm-lock.yaml` (in a rebase, "ours" = the upstream/base side), then `vp install` from the repo root to reconcile against the merged set of `package.json` files, then re-`git add` before `git rebase --continue`. Works the same taking ours or theirs; the install pass is what makes it correct.

### Your primary cwd may be a worktree on a different branch

An agent's primary working directory can be a worktree pointing at a branch other than the target. Run `git worktree list` before checkout/rebase/commit — the target branch is often already checked out elsewhere (`git checkout` fails with "already checked out at …"). Use `git -C <owning-path> <subcommand>` or `cd` to that worktree.

### Replying to vs. resolving PR review comments mixes REST and GraphQL

Inline replies are REST (`POST /repos/{o}/{r}/pulls/{n}/comments/{commentId}/replies`); thread _resolution_ is GraphQL only (`resolveReviewThread` mutation — no REST endpoint exposes it). Map comment IDs to thread IDs via `repository.pullRequest.reviewThreads`, joining on `comments.nodes[0].databaseId`. The MCP GitHub tools also expose thread resolution (`resolve_review_thread` / `unresolve_review_thread`).

## Auth & bootstrap design

### Token validity ≠ consent record

Gating token validity on "is there a consent Grant for this `sub`?" is a category error: a Grant is a consent fast-path (skip the prompt on `/oauth/authorize`), while token validity is a separate question (signature + exp + iss + aud + sub-is-a-known-client). Conflating them means a token minted directly by a privileged process (e.g. a bootstrap URL signed with the key the host already holds) gets rejected by its own verifier because no Grant exists. `verifyJwt` should look up `sub` in the client-registration table, not Grants; per-route middleware enforces the token's `scope` claim.

### Bearer-only auth makes HTML pages public; cookie auth makes them gateable

Browsers auto-attach `Cookie` on top-level navigations but never `Authorization`. So an auth middleware on an HTML-page endpoint is meaningful under cookie auth but _wrong_ under Bearer auth (the navigation carries no token → permanent 401, no JS ever runs). Under Bearer auth: HTML pages are public; the page's JS reads a token from `localStorage` and attaches it to the API calls it makes. Easy to almost-ship a half-correct middleware that has to be reverted mid auth-model migration.

### Mint-and-hand-off-URL is a universal bootstrap primitive

Any process with signing-key access can mint a short-lived token out-of-band and hand it to a browser via URL (`?token=…`); page JS reads it on load, stashes it, then strips it via `history.replaceState`. This one primitive covers cold-start first-Owner bootstrap, native-shell webview embed, dev auto-login, CLI login, and share-to-another-device. Defenses: short TTL, `Referrer-Policy: no-referrer` on the receiving page, replaceState strip on first read (JTI single-use is a deferrable hardening). When designing a bootstrap mechanism, look for a capability the privileged process _already has_ and build the hand-off around it rather than inventing a "setup mode."

### When a custom flow feels slapdash, check if it's a partial RFC

A hand-rolled flow that feels ad hoc is often a spec you're implementing without knowing it. A bespoke PIN flow turned out to be OAuth Device Authorization (RFC 8628) line-for-line (PIN ↔ user_code, challenge id ↔ device_code, verification page ↔ verification_uri, complete ↔ token endpoint); recognizing it collapsed three concepts into one and shrank the slice. Search "OAuth/IETF/RFC + the words you named the flow with" — the standard buys discoverability and familiar UX.

## SPA static-fallback servers

### Normalise URL paths with the WHATWG `URL`, reject traversal per-segment

`new URL('/foo/../bar', 'http://x/').pathname` → `/bar` gives built-in `..` normalisation with no `node:path`. Two gotchas: (1) _protocol-relative collapse_ — `//foo/bar` parses `foo` as authority and drops the segment, so pre-collapse leading slashes to a single `/` before parsing; (2) _percent-encoded traversal_ — `URL` only normalises literal `.`/`..`, so `/%2E%2E/…` survives; decode each `/`-split segment with `decodeURIComponent` and reject `..` (also catches mixed-case `%2e` and malformed `%` sequences, which throw).

### Three response buckets: file / 302→`/` / index.html

A SPA-fallback handler has three legitimate responses for a pathname; conflating any two causes security blind-spots or UX papercuts. (1) _direct hit_ → serve the real file. (2) _deep link / unknown but well-formed_ (e.g. `/gatekeeper/requests`) → serve `index.html` so the SPA router takes over. (3) _sketchy_ (`..` literal or encoded, null bytes) → **302 to `/`**, not 200 with the shell — a probe shouldn't get the SPA rendered at its chosen URL, and the 302 distinguishes the bucket in logs. "Always serve index.html on miss" silently 200-OKs probes; "404 on traversal" is needlessly hostile to mistyped legitimate requests.

## Code & module organization

### Noun-focused modules + `export * as Namespace` mirror Effect's surface

Split task-focused files (`define-bridge.ts`, `transport.ts`) into noun-focused modules (`bridge.ts`, `bridge-transport.ts`, `message.ts`, …) and re-export each as a namespace from the barrel (`export * as Bridge from './bridge.ts'`). Convention: file = kebab-case noun; primary type alias = the namespace name (`Bridge.Bridge<…>`); constructor = `make`; secondary types flat inside the namespace. Exception: user-defined `Context.Tag` classes stay direct top-level exports — they're values, and `Layer.succeed(TransportAdapter, …)` reads better than `Layer.succeed(TransportAdapter.TransportAdapter, …)`.

### Generic test helpers go in `kitchen-sink/test`; project-shape ones in slice subpaths

The test: "could a totally unrelated project reuse this?" Generic Effect/Logger plumbing (capturing-logger factory, `runScoped` boilerplate, assertions) belongs in `kitchen-sink/test` so even project-agnostic `global/` packages can pull it. Wildflower-specific helpers (anything touching a singleton runtime slot or a slice's contracts) belong in the slice's `<slice>/testing` subpath. Do the split up front — a single dumping-ground `testing` export drags slice-specific helpers into global packages' tests.

### Bridge side discriminator is `'Host' | 'Web'`, never `'Native'`

For a cross-process WebView bridge, "Native" is overloaded (React Native vs JS vs platform layer). Use `Host` for the side hosting the embedded WebView, `Web` for the embedded page; reserve "Native" for `react-native` library context. The rename cascades: `bridge.Host`, `hostToWeb`/`webToHost` config keys, `HostBackRequested`/`HostRequestedWebNavigation` tags, `Navigation.Host.HandlerTag`.

### Pre-mount a `<NavigateBinder>` for module-load Effect handlers

Bridge handlers registered at module load (before any React mount) fire before `useNavigate()` exists. Pattern: a module-private `navRef` + `queue`; handlers call `navRef.current` if set, else push to the queue. A `<NavigateBinder navRef queue />` mounted inside the router sets `navRef.current` from `useNavigate()` in a one-shot `useEffect` and drains the queue. Cleaner than threading `useNavigate()` into layer construction (which happens before React exists).

### Augment `Window` without `declare global`

Augmenting the global `Window` interface requires a module file, but adding `export {}` trips `unicorn/require-module-specifiers`. Instead, put a top-level `interface Window { ... }` in a file that already has a triple-slash reference — the file stays ambient and the interface merges with the global `Window` directly, no `declare global` needed.

### Enumerate use cases before naming an abstraction

When proposing a new abstraction, list the concrete use cases _first_ and let the human name the concept _after_ seeing them. An early "Bootstrap" abstraction conflated four distinct concerns (window-globals, URL params, auth-token handoff, postMessage protocol); re-decomposing each case landed a cleaner "everything is Messages" framing. `AskUserQuestion` is most useful for naming and scoping after enumeration, not for a-priori category proposals.

## Rust

### Privatizing modules doubles as a dead-code detector

`rustc`'s `dead_code` lint only fires on items that aren't pub-reachable from the crate root, so flipping `pub mod` → private `mod` behind re-exports instantly surfaces genuinely-dead functions and enum variants that were invisible for the module's whole life. Expect new warnings when tightening visibility — they're findings, not regressions. Within one crate you can also split a domain type from its persistence: trait impls (`ToSql`/`FromSql`/`TryFrom<&Row>`) and inherent impls can live in a different module than the type's definition, and inherent methods take their own visibility (`impl Client { pub(in crate::db) fn … }`). Trap: a borrowed-params array (`[(&str, &dyn ToSql); N]`) can't hold a field that needs an owned wrapper created at persist time — bind the wrapper to a local and use `rusqlite::named_params!` instead.

## Transient advice

Entries here may become stale as tools and workflows evolve. Agents should periodically check whether these are still accurate and note in the [Learnings Inbox](./Learnings%20Inbox.md) if something is outdated.

### Write tool "File has not been read yet" false positives

The Write tool tracks which files you've read and refuses to write to a file it thinks you haven't read. This tracking can fail when:

- **Context compression** drops the earlier Read from the tool's tracking, even though the content was in your context
- **Multiple parallel tool calls** — if one sibling call fails, the Write tool may report "Sibling tool call errored" on all others in the batch
- **Large conversations** — as the conversation grows, earlier Reads may no longer register

**Workarounds**:

1. If Write fails, re-Read the file (even just `limit: 5` lines) immediately before retrying
2. For batch writes across many files, prefer sequential over parallel to avoid the sibling-error cascade
3. Use Edit instead of Write when possible — Edit is less prone to this issue since it verifies against the file content directly

### Parallel tool calls: sibling error cascade

When you make multiple tool calls in a single message and one fails, all siblings may also fail with "Sibling tool call errored". This wastes a turn. To mitigate:

- Only parallelize tool calls that are very likely to succeed
- For writes to files you haven't recently read, do the reads first, then the writes

## Communicate proactively with the user

- If a refactor is going to touch 30 files, say so upfront with a rough context budget estimate
- If you're 40% through context and 20% through the work, surface it — don't wait for the user to notice
- When you discover a non-obvious gotcha mid-execution, note it immediately in the handoff doc
