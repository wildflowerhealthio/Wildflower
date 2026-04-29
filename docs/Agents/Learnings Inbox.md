# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

<!-- Append new entries below this line -->

### LiveStore row types widen `text()` columns to `string`

**Discovered during**: ruthmarks/add-fhir-server — Phase 3 (gatekeeper-core dashboard endpoints)
**Learning**: When an HTTP response Schema uses `Schema.Literal(...)` for a field backed by a `State.SQLite.text()` column, `store.query(...)` won't type-check — the row's field is typed `string`, not the narrow union. Widen the response schema to `Schema.String` rather than projecting rows through a cast; the DB genuinely holds unconstrained strings.
**Suggested destination**: Strategies

### Phantom-id bridge for cross-`HttpApi` composition

**Learning**: `HttpApiGroup.ApiGroup<ApiId, Name>` is a structural marker with no runtime presence — `HttpApiBuilder.group` only registers routes on the shared Router and nothing reads `apiId`. So a Layer built against a child `HttpApi` is sound to satisfy a parent `HttpApi`'s group requirement via `as unknown as Layer.Layer<HttpApiGroup.ApiGroup<ParentId, Name>>`. Every web/domain package exports its own `*ApiHandlersFor<ParentId>()` helper that performs this cast in one place with a comment. This is the whole mechanism that lets `wildflower-node` compose `AuthApi + AppsApi + AppsWebApi + ...` into a single `WildflowerNodeApi`.
**Suggested destination**: Strategies

### Self-reference imports in `vp pack` with `platform: 'neutral'`

**Learning**: A package can `import { x } from 'self-name/subpath'` inside its own src files and `vp pack` with `platform: 'neutral'` + `exports: false` preserves it as an external at bundle time. Node's self-reference resolution handles it at runtime via the package's own `exports` map. You get a "Could not resolve" warning during pack; it's expected and correct. Don't replace with a relative `../dist/*` path — that breaks once the package is published or re-bundled.
**Suggested destination**: Strategies

### Two-config shape: Vite app build + `vp pack` library entries

**Learning**: A single `defineConfig({...})` can hold both a Vite app config (`plugins`, `build.outDir`) and a `pack` config (`pack.entry`, `pack.platform`) because they emit different filenames (`index.html`/`html.js` vs `<entry>.js`). One script drives both: `"build": "vp run build:html && vp run build:lib"` where `build:html` runs `vp build` and `build:lib` runs `vp pack`. Ordering matters if the pack entries import from the html-emitted module.
**Suggested destination**: Strategies

### `git stash push` doesn't capture untracked files by default

**Learning**: When trying to baseline pre-existing errors in a repo, `git stash push -- <path>` leaves untracked files in place. Use `git stash push --include-untracked` for a true clean baseline. Hit this while trying to confirm whether test errors in gatekeeper-core were pre-existing or introduced by new files.
**Suggested destination**: unsure

### `HttpApiClient` methods return `Effect`, not `Promise`

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web)
**Learning**: Client methods produced by `HttpApiClient.make(Api, { baseUrl })` return `Effect.Effect<A, E, R>` — `await`-ing them directly triggers oxlint's `await-thenable`. Wrap the runtime with a helper: `const runAuth = async <A,E>(f: (c: Client) => Effect.Effect<A, E, R>): Promise<A> => runtime.runPromise(f(await clientPromise))`, then call as `await runAuth((c) => c.group.Method(args))`. Same pattern applies to any `HttpApiClient`-produced client across the repo.
**Suggested destination**: Strategies

### Derive HTTP response types from Schemas, not from `ReturnType<Client[G][M]>`

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web)
**Learning**: `HttpApiClient` methods carry a `<WithResponse extends boolean = false>` generic. `ReturnType<Client['group']['method']>` without instantiation produces a 3-way union `Effect<A | HttpClientResponse | [A, HttpClientResponse], ...>` that can't be narrowed structurally — attempted Unwrap helpers resolved to `unknown`. Instead: export the original `Schema.Struct` from the API definition package and derive client-side types as `Schema.Schema.Type<typeof Schema>`. Cleaner, stable across client refactors, and keeps the web and server types tied to the same source.
**Suggested destination**: Strategies

### Multiple `topLevel: true` groups under one `HttpApi` collide in the client type

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web FHIR patient picker)
**Learning**: `FhirResourcesApi` composes `Patient` + `Binary` + `Observation`, each an `HttpApiGroup` built with `{ topLevel: true }`. `HttpApiClient.make(FhirResourcesApi, ...)` hoists all groups' endpoints to the client root, so `Collection`, `Create`, etc. collide by name — the inferred client type is effectively `{ Collection: ..., Create: ... }` (last-added group wins). `client.Patient.Collection()` doesn't typecheck; neither does `client.Collection()` for distinguishing which resource. Either address each resource with its own `HttpApiClient` against a single-group `HttpApi`, drop `topLevel: true`, or fall back to raw `fetch('/fhir-r4/Patient')`. The current composition is likely a bug — `topLevel` is designed for single-group APIs.
**Suggested destination**: Strategies

### `declare global { interface Window }` vs. ambient augmentation

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web env.d.ts)
**Learning**: Augmenting the global `Window` interface requires the file to be a module. Adding `export {}` to make it a module trips `unicorn/require-module-specifiers` ("empty export specifier is not allowed"). Alternative: put `interface Window { ... }` at the top level of a file that already has a triple-slash reference — the file stays ambient and the top-level `interface` merges with the global `Window` directly, no `declare global` needed.
**Suggested destination**: Strategies

### `vp check --fix` mangles complex multi-line types

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web)
**Learning**: Running `vp check --fix` stripped the `| PinRequest` member from a multi-line discriminated-union type alias and inlined an oxlint-disable comment where it no longer applied. `vp fmt` alone is safer for formatting, and the `--fix` flag is best reserved for narrow, recently-edited files you can diff carefully afterward.
**Suggested destination**: Strategies
