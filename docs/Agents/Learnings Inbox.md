# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

<!-- Append new entries below this line -->

## Decompose property tests by column to escape graph-walk fan-out

**Discovered during**: ruthmarks/add-fhir-r4-slice — slow-test investigation
**Learning**: A property test that does `Arbitrary.make(WholeSchema)` walks the entire schema graph every iteration. For FHIR resource-level schemas (Patient, Observation, Bundle) that's untenable — Reference→Identifier cycle, CodeableConcept-with-Coding[], Element/Extension fan-out, plus JSON column encode/decode all multiply. The fix is **per-column decomposition**: pick one field via `Schema.pick(name)` and round-trip just that sub-schema. Drove emr-core wall-clock from 745s with 14 timeouts to ~78s with 0. Use `test.each` with a `columnCases` array of `{ name, numRuns? }` so per-column overrides stay readable. Two viable patterns: pick-only round-trip (fastest, used in emr-core) and shell-spread + whole-schema round-trip (used in fhir-r4 to preserve wire-format adapter end-to-end coverage).
**Suggested destination**: docs/Testing/Property Testing Reference.md

## `Schema.Struct.pick(...)` doesn't propagate `R = never` when fields use `Schema.suspend`

**Discovered during**: ruthmarks/add-fhir-r4-slice — slow-test investigation
**Learning**: When a `Schema.Struct` has fields that reach `Schema.suspend(...)` (e.g. Reference→Identifier cycle), `Schema.Struct.pick(...)` widens the resulting schema's `Context` parameter to `unknown` at the type level, even though every column is no-context at runtime. `Schema.encodeSync`/`Schema.decodeSync` then fail to typecheck because they require `R = never`. Workaround in test files: cast via `as unknown as Schema.Schema.AnyNoContext` (or `as unknown as fc.Arbitrary<Pick<T, K>>` if the helper returns the Arbitrary). The runtime is correct; the cast just bridges the structural-vs-named-type mismatch in TS inference. Pair with an `oxlint-disable-next-line typescript/no-unsafe-type-assertion` and a comment explaining the bridge.
**Suggested destination**: docs/Effect/Patterns Reference.md

## `AnnotateArrayWithArbitrary({ maxLength: N })` is a test-only knob, not a schema constraint

**Discovered during**: ruthmarks/add-fhir-r4-slice — slow-test investigation
**Learning**: `AnnotateArrayWithArbitrary` (from kitchen-sink/schema) only modifies `Arbitrary.make(...)`'s output — encode/decode behaviour is unchanged. Use it to cap unbounded arrays whose size only matters for property-test fan-out (e.g. CodeableConcept's unbounded `coding: Coding[]`, Meta's `security`/`tag` Coding arrays). Production code can still hold arbitrary-length arrays. Capping CodeableConcept.coding to maxLength 2 alone gave a ~5× speedup on every CodeableConcept-bearing test.
**Suggested destination**: docs/Testing/Property Testing Reference.md

## Avoid `Arbitrary.make(...).map(encode→decode)` normalisation in property tests — it doubles per-iteration cost

**Discovered during**: ruthmarks/add-fhir-r4-slice — slow-test investigation
**Learning**: When a sub-schema has `Schema.optional` fields that emit `undefined` from arbitrary but get stripped on encode, the round-trip `expect(decoded).toSchemaEqual(sub, value)` fails on undefined-vs-missing-key. The "fix" of normalising via `Arbitrary.make(sub).map(v => decodeSync(sub)(encodeSync(sub)(v)))` works but doubles every iteration's encode/decode cost — applying it universally tipped many other tests over their timeouts. Better: write a fixture-based test for the specific Schema.optional case, or constrain the field's arbitrary annotation. The whole-RowSchema arbitrary in `livestore/observation.ts` uses this same trick and is the slowest test in the suite — be aware it inflates costs.
**Suggested destination**: Strategies

**Discovered during**: ruthmarks/add-fhir-server — Phase 3 (gatekeeper-core dashboard endpoints)
**Learning**: When an HTTP response Schema uses `Schema.Literal(...)` for a field backed by a `State.SQLite.text()` column, `store.query(...)` won't type-check — the row's field is typed `string`, not the narrow union. Widen the response schema to `Schema.String` rather than projecting rows through a cast; the DB genuinely holds unconstrained strings.
**Suggested destination**: Strategies

## Phantom-id bridge for cross-`HttpApi` composition

**Learning**: `HttpApiGroup.ApiGroup<ApiId, Name>` is a structural marker with no runtime presence — `HttpApiBuilder.group` only registers routes on the shared Router and nothing reads `apiId`. So a Layer built against a child `HttpApi` is sound to satisfy a parent `HttpApi`'s group requirement via `as unknown as Layer.Layer<HttpApiGroup.ApiGroup<ParentId, Name>>`. Every web/domain package exports its own `*ApiHandlersFor<ParentId>()` helper that performs this cast in one place with a comment. This is the whole mechanism that lets `wildflower-node` compose `AuthApi + AppsApi + AppsWebApi + ...` into a single `WildflowerNodeApi`.
**Suggested destination**: Strategies

## Self-reference imports in `vp pack` with `platform: 'neutral'`

**Learning**: A package can `import { x } from 'self-name/subpath'` inside its own src files and `vp pack` with `platform: 'neutral'` + `exports: false` preserves it as an external at bundle time. Node's self-reference resolution handles it at runtime via the package's own `exports` map. You get a "Could not resolve" warning during pack; it's expected and correct. Don't replace with a relative `../dist/*` path — that breaks once the package is published or re-bundled.
**Suggested destination**: Strategies

## Two-config shape: Vite app build + `vp pack` library entries

**Learning**: A single `defineConfig({...})` can hold both a Vite app config (`plugins`, `build.outDir`) and a `pack` config (`pack.entry`, `pack.platform`) because they emit different filenames (`index.html`/`html.js` vs `<entry>.js`). One script drives both: `"build": "vp run build:html && vp run build:lib"` where `build:html` runs `vp build` and `build:lib` runs `vp pack`. Ordering matters if the pack entries import from the html-emitted module.
**Suggested destination**: Strategies

## `git stash push` doesn't capture untracked files by default

**Learning**: When trying to baseline pre-existing errors in a repo, `git stash push -- <path>` leaves untracked files in place. Use `git stash push --include-untracked` for a true clean baseline. Hit this while trying to confirm whether test errors in gatekeeper-core were pre-existing or introduced by new files.
**Suggested destination**: unsure

## `HttpApiClient` methods return `Effect`, not `Promise`

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web)
**Learning**: Client methods produced by `HttpApiClient.make(Api, { baseUrl })` return `Effect.Effect<A, E, R>` — `await`-ing them directly triggers oxlint's `await-thenable`. Wrap the runtime with a helper: `const runAuth = async <A,E>(f: (c: Client) => Effect.Effect<A, E, R>): Promise<A> => runtime.runPromise(f(await clientPromise))`, then call as `await runAuth((c) => c.group.Method(args))`. Same pattern applies to any `HttpApiClient`-produced client across the repo.
**Suggested destination**: Strategies

## Derive HTTP response types from Schemas, not from `ReturnType<Client[G][M]>`

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web)
**Learning**: `HttpApiClient` methods carry a `<WithResponse extends boolean = false>` generic. `ReturnType<Client['group']['method']>` without instantiation produces a 3-way union `Effect<A | HttpClientResponse | [A, HttpClientResponse], ...>` that can't be narrowed structurally — attempted Unwrap helpers resolved to `unknown`. Instead: export the original `Schema.Struct` from the API definition package and derive client-side types as `Schema.Schema.Type<typeof Schema>`. Cleaner, stable across client refactors, and keeps the web and server types tied to the same source.
**Suggested destination**: Strategies

## Multiple `topLevel: true` groups under one `HttpApi` collide in the client type

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web FHIR patient picker)
**Learning**: `FhirResourcesApi` composes `Patient` + `Binary` + `Observation`, each an `HttpApiGroup` built with `{ topLevel: true }`. `HttpApiClient.make(FhirResourcesApi, ...)` hoists all groups' endpoints to the client root, so `Collection`, `Create`, etc. collide by name — the inferred client type is effectively `{ Collection: ..., Create: ... }` (last-added group wins). `client.Patient.Collection()` doesn't typecheck; neither does `client.Collection()` for distinguishing which resource. Either address each resource with its own `HttpApiClient` against a single-group `HttpApi`, drop `topLevel: true`, or fall back to raw `fetch('/fhir-r4/Patient')`. The current composition is likely a bug — `topLevel` is designed for single-group APIs.
**Suggested destination**: Strategies

## `declare global { interface Window }` vs. ambient augmentation

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web env.d.ts)
**Learning**: Augmenting the global `Window` interface requires the file to be a module. Adding `export {}` to make it a module trips `unicorn/require-module-specifiers` ("empty export specifier is not allowed"). Alternative: put `interface Window { ... }` at the top level of a file that already has a triple-slash reference — the file stays ambient and the top-level `interface` merges with the global `Window` directly, no `declare global` needed.
**Suggested destination**: Strategies

## `vp check --fix` mangles complex multi-line types

**Discovered during**: ruthmarks/add-fhir-server — Phase 2a (gatekeeper-web)
**Learning**: Running `vp check --fix` stripped the `| PinRequest` member from a multi-line discriminated-union type alias and inlined an oxlint-disable comment where it no longer applied. `vp fmt` alone is safer for formatting, and the `--fix` flag is best reserved for narrow, recently-edited files you can diff carefully afterward.
**Suggested destination**: Strategies

## Expo Metro on macOS binds IPv6-only without `--dns-result-order=ipv4first`

**Discovered during**: ruthmarks/global-expo-localtunnel — diagnosing Android dev client "Unable to load script"
**Learning**: On macOS, `getaddrinfo("localhost")` returns `::1` before `127.0.0.1`, and Node binds `server.listen({ host: 'localhost' })` to the first resolved address only. `expo start --localhost` therefore lands Metro on `[::1]:8081`. The Android emulator's `adb reverse` forwards via IPv4, so the dev client cannot fetch the bundle and crashes with `Unable to load script` before any JS runs. Symptom: blank white screen on Android, iOS Simulator works fine because it shares the host's network stack and reaches `[::1]` directly. Fix: prefix every Expo CLI script (`start`, `run:android`, `run:ios`) with `NODE_OPTIONS=--dns-result-order=ipv4first`. Both example apps under `global/expo-localtunnel/example` and `global/expo-effect-platform/example` already do this — copy the pattern when adding new Expo example apps.
**Suggested destination**: Strategies (or a new `docs/Expo/Local Dev How-To.md`)
