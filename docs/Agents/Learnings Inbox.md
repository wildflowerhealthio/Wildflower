# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

<!-- Append new entries below this line -->

## `PersistQueryClientProvider` + `<StrictMode>` deadlocks testing-library `act`/`waitFor`

**Discovered during**: ruthmarks/mount-query-client-persist-provider
**Learning**: Mounting `@tanstack/react-query-persist-client`'s `PersistQueryClientProvider` inside `<StrictMode>` and then driving it through testing-library's `act` / `waitFor` (or `await act(async () => createRoot(...).render(...))`) hangs until the 5s test timeout. StrictMode double-invokes the provider's restore effect; the async `persistQueryClientRestore` + the `setIsRestoring(false)` re-render + the live `persistQueryClientSubscribe` subscription leave a pending async transition that `act` waits on forever **in jsdom only** — the real tree renders fine in a browser, and a manual DOM poll (`document.querySelector(...)` in a `setTimeout` loop, outside `act`) confirms the leaf does mount within ~100ms. Two fixes depending on intent: (1) to test the persister wiring, render WITHOUT StrictMode via a plain testing-library `render` (no `createRoot`); (2) to drive the real `renderApp` (which uses StrictMode), either mock the persist provider down to a passthrough / real `<QueryClientProvider>` stand-in, or assert via a manual DOM poll instead of `waitFor`. The deadlock is a harness artifact, not a production bug.
**Suggested destination**: docs/Testing/Testing Reference.md (React testing)

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

## Token validity ≠ consent record — `verifyJwt` looks up the wrong table

**Discovered during**: ruthmarks/add-gatekeeper-core — Plan.md review for the device-flow rework
**Learning**: It's tempting to gate token validity on "is there an OAuth Grant for this `sub`?". That's a category error: a Grant is a consent record (skip-prompt fast path on `/oauth/authorize`); token validity is a separate question (signature + exp + iss + aud + sub-is-known-client). Conflating the two means any token minted directly by a privileged process — e.g. a bootstrap URL where the host signs a token using the signing key it already holds — gets rejected by its own verifier, because no Grant exists for the sub. Fix: `verifyJwt` looks up `sub` in `Clients` (the registration table), not `Grants`. Grants stay; they drive the consent fast path. Tokens carry their `scope` claim; per-route middleware enforces scope. Caught this in plan review before any code was written, but the original `gatekeeper-core` actually shipped the wrong shape — it just happened that nothing minted tokens outside the auth-code flow yet.
**Suggested destination**: Strategies

## `HttpApiEndpoint` has `.middleware()` — per-endpoint, not just per-group

**Discovered during**: ruthmarks/add-gatekeeper-core — adding auth to a subset of `gatekeeper-pages`
**Learning**: `HttpApiGroup.make(...).middleware(M)` applies `M` to every endpoint in the group. If the group has mixed auth requirements (e.g. some HTML pages public, others operator-only), you can chain `.middleware(M)` on the individual `HttpApiEndpoint` builder before `.add(...)`-ing it to the group instead of splitting the group. Saves a phantom-id bridge for what is really one logical page contract.
**Suggested destination**: docs/Effect/HttpApi Composition How-To.md

## Bearer-only auth makes HTML pages public; cookie auth makes them gateable

**Discovered during**: ruthmarks/add-gatekeeper-core — migrating away from session cookies
**Learning**: Browsers auto-attach `Cookie` headers on top-level navigations. They don't auto-attach `Authorization` headers. So `RequireAuthMiddleware` on an HTML page endpoint is meaningful in a cookie-auth world (server-side gate intercepts unauthorized navigations), but it's wrong in a Bearer-auth world (the navigation has no Authorization header, so the page is permanently 401 — no JS gets a chance to attach the token). In Bearer-auth: HTML pages are public; the JS on them gates UI by checking for a token in `localStorage` and attaches it to the API calls the page makes. Easy to almost-ship a half-correct middleware addition that has to be reverted as part of an auth-model migration.
**Suggested destination**: Strategies

## Replying to and resolving PR review comments mixes REST and GraphQL

**Discovered during**: ruthmarks/add-gatekeeper-core — bulk-resolving rocket-reacted threads on PR #19
**Learning**: Inline replies use REST: `POST /repos/{o}/{r}/pulls/{n}/comments/{commentId}/replies` with `{ body }`. Thread resolution is GraphQL only: `mutation { resolveReviewThread(input: { threadId }) { thread { isResolved } } }` — no REST endpoint exposes this. To map comment IDs → thread IDs, query `repository.pullRequest.reviewThreads` via GraphQL once and join on `comments.nodes[0].databaseId`. A small bash helper that wraps both calls is enough to bulk-resolve dozens of stale threads with one-line replies pointing at the commit that addressed them.
**Suggested destination**: Strategies

## When a custom flow feels slapdash, check if it's a partial RFC

**Discovered during**: ruthmarks/add-gatekeeper-core — recognizing the PIN flow as proto-RFC 8628
**Learning**: The bespoke PIN flow (PIN displayed on a polling page, Owner enters it on a different device, polling page picks up approval, browser session established) was a hand-rolled variant of OAuth Device Authorization Flow (RFC 8628). Once you see it, the mapping is line-by-line: PIN ↔ user_code, challenge id ↔ device_code, `/login/pin/:id/page` ↔ verification_uri, `/login/pin/:id/complete` ↔ token endpoint. Recognizing this collapsed three concepts (bespoke PIN flow + sessions table + cookies) into one (RFC 8628) and shrunk the slice. Meta-strategy: when a flow you've designed feels slapdash, search "OAuth/IETF/RFC + the words you used to name the flow" — chances are someone wrote a spec for it and you're partway to implementing it without the discoverability and familiar UX the standard buys you.
**Suggested destination**: Strategies

## Mint-and-hand-off-URL as a universal bootstrap primitive

**Discovered during**: ruthmarks/add-gatekeeper-core — designing Owner bootstrap for fresh deployments
**Learning**: Any process with signing-key access can mint a short-lived access token without going through HTTP. Hand it to a browser via URL (`?token=...`); page JS reads it on load, stashes in localStorage, strips via `history.replaceState` so it doesn't persist in the address bar / Referer / browser history. This single primitive replaces a bunch of bespoke shapes: cold-start "first-Owner" bootstrap, native-shell embed (URL handed to webview), dev-mode auto-login (`vp run dev` prints a URL), CLI login (open in default browser), share-with-other-device. Defenses against URL leakage: short TTL (5 min), `Referrer-Policy: no-referrer` on the receiving page, replaceState strip on first read. JTI single-use tracking is a deferable hardening if a real threat model demands it. Lesson: when designing a bootstrap mechanism, look for a primitive the privileged process _already has_ (signing key, DB write, etc.) and build the hand-off shape around it rather than introducing a new "setup mode" concept.
**Suggested destination**: Strategies

## `Match.when({ field: literal }, ...)` matches type and value in one arm

**Discovered during**: ruthmarks/add-wildflower-node — refactoring OAuth-error dispatch in `NeedsAuthMessage`
**Learning**: Effect's `Match.when` accepts a structural object pattern that tests fields by literal equality on the runtime input — `Match.when({ error: 'access_denied' }, (body) => …)` matches anything where `body.error === 'access_denied'` and narrows `body.error` to that literal in the handler. Combined with `Match.withReturnType<T>()` to pin the matcher's overall result type, you get Haskell/Rust-style flat dispatch on type AND value with no inner `if` chain or boolean expression: each arm names "this shape" → "this outcome" in one line. Adding a new specific case is one new `Match.when` clause; broader-than-literal cases use `Schema.is(SomeSchema)` or `Predicate.or(Schema.is(A), Schema.is(B))` as the predicate. Order top-to-bottom: most specific to least specific to `orElse`. Custom `Predicate.and(Schema.is(...), hasErrorCode(literal))` helpers are unnecessary when the schemas are uniquely structured by the literal-typed discriminator field — just match on the field directly.
**Suggested destination**: docs/Effect/Patterns Reference.md

## `HttpApiBuilder.Router.use` route handlers can only require `DefaultServices | Provided`

**Discovered during**: ruthmarks/add-wildflower-node — wiring a static-SPA fallback into the API Router
**Learning**: `HttpApiBuilder.Router.use((router) => router.get('*', handler))` constrains the handler to `Handler<unknown, DefaultServices | Provided>` where `DefaultServices = HttpPlatform | Etag | FileSystem | Path` and `Provided = RouteContext | HttpServerRequest | ParsedSearchParams | Scope`. Arbitrary application Tags (e.g. a runtime-configured `WebAssetsDir`) don't fit and won't typecheck inside the handler. Two ways out: (a) accept the value as a function parameter and close over it at Layer construction (loses Tag-style DI), or (b) read the Tag at Layer-build time via `Layer.unwrapEffect(Effect.map(Tag, makeLayerFromValue))` — the resulting Layer carries the Tag in its `R`, the inner handler closes over the resolved value, and the runner provides it via `Layer.succeed(Tag, value)`. (b) is the right answer when you want the runner to wire the value through context. Same pattern works for any Effect Layer that needs to read a Tag-bound value at construction time but can't surface that requirement through to a downstream API.
**Suggested destination**: docs/Effect/HttpApi Composition How-To.md

## URL pathname normalisation: protocol-relative collapse and percent-encoded traversal

**Discovered during**: ruthmarks/add-wildflower-node — replacing `node:path.normalize` with `new URL(...).pathname` in static-spa
**Learning**: The WHATWG URL constructor normalises `..` segments at parse time, so `new URL('/foo/../bar', 'http://x/').pathname` returns `/bar` — built-in, cross-platform, no `node:path` needed. Two non-obvious gotchas: (1) **protocol-relative collapse** — `new URL('//foo/bar', 'http://x/').pathname` is `/bar` because `//foo` parses as authority (host=foo), silently dropping the first path segment of an HTTP request like `GET //assets/app.js`. Pre-collapse leading slashes to a single `/` before parsing. (2) **percent-encoded traversal slips through** — `URL` only normalises literal `.`/`..` segments, so `/%2E%2E/etc/passwd` survives normalisation as a non-`..` path. To reject probes, decode each `/`-split segment with `decodeURIComponent` and check for `..` against that — also catches mixed-case encodings (`%2e`, `%2E`) and malformed `%`-sequences (decoder throws). Net pattern for SPA static-fallback servers: `URL` for normalisation + per-segment decoded-equality check for traversal rejection.
**Suggested destination**: Strategies

## Three-bucket SPA static-fallback: file / 302→`/` / index.html

**Discovered during**: ruthmarks/add-wildflower-node — designing the static-spa response policy
**Learning**: A SPA-fallback HTTP handler has three legitimate response shapes for a given pathname, and conflating any two causes either security blind-spots or UX papercuts: (1) **direct hit** — pathname maps to a real file under the assets root, serve it. (2) **deep link / unknown** — pathname is well-formed but the file doesn't exist (e.g. `/gatekeeper/requests`), serve `index.html` so the SPA's router takes over. (3) **sketchy** — pathname contains `..` segments (literal or percent-encoded) or null bytes, **302 to `/`** rather than 200-OK with the SPA shell. The redirect choice over 404 is intentional: a confused legitimate user lands somewhere working, a probe doesn't get the SPA shell rendered at the URL it picked, and the 302 status code distinguishes the bucket for any log/dashboard watching for traversal probes. The naive "always serve index.html on file-miss" collapses (2) and (3) into the same response, which silently 200-OKs probes; the also-common "404 on traversal" is more hostile to mis-typed legitimate requests than necessary.
**Suggested destination**: Strategies

## Cross-package `tsconfig.json` includes silently break `vp pack` dts emission

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: A `tsconfig.json` `"include"` entry that points at a sibling package's file (e.g. `"../navigation-react/tests/query-param.test.ts"` inside `navigation-core/tsconfig.json`) widens the TypeScript program for that package to span both directories. Combined with `vp pack`'s `dts: { tsgo: true }` + `declaration: true`, tsgo emits a `.d.ts` for the cross-package file _into the sibling's dist tree_, polluting `slices/navigation/navigation-react/` with output that navigation-core "owns". The path was almost certainly autogen'd by some tool and never load-tested; sibling packages' own tsconfigs already cover their `tests/`, so the cross-include is both wrong and redundant. When chasing "where are these stray .d.ts files coming from," grep `tsconfig.json` `include`/`files`/`references` arrays across the workspace for `..` paths.
**Suggested destination**: Strategies

## `Context.Tag['Type']` retires the parallel `XxxShape` interface

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: `class Tag extends Context.Tag('...')<Tag, Service>() {}` makes `Tag['Type']` an alias for `Service`, so any place a consumer would otherwise reach for a separately-exported `TagShape` interface can index the Tag directly. Removes the pattern of `interface PlatformAdapterShape { ... } class TransportAdapter extends Context.Tag('...')<TransportAdapter, PlatformAdapterShape>() {}` plus the dual export — one declaration, one source of truth. Callers writing custom adapter values type them as `TransportAdapter['Type']`. Same idea works wherever Effect's `Context.Tag` is the value-bearing type and a sibling interface only exists to seed the second type parameter.
**Suggested destination**: docs/Effect/Patterns Reference.md

## Bake an internal context requirement via `Effect.provideService` to reshape the public type

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: When a higher-order Effect surface has internal callbacks that need a `Context.Tag` (e.g. each bridge's per-tag sender requires `TransportAdapter`), the natural typing surfaces that requirement on every public-facing call. To keep the consumer-visible type clean (e.g. `transport.sendMessage(m): Effect<void>` instead of `Effect<void, never, TransportAdapter>`), resolve the Tag once at construction time inside the scoped Effect, then satisfy the inner callbacks via `Effect.provideService(Tag, value)` at the boundary. Tests can still swap implementations by providing a different value via `Layer.succeed(Tag, stub)` to the constructor itself; only the _public closure_ hides the requirement. Pattern applies any time you have "this thing internally needs X, but consumers shouldn't have to provide X every time they call into it."
**Suggested destination**: docs/Effect/Patterns Reference.md

## `SubscriptionRef` is the right shape for a "set-once, observable" runtime slot

**Discovered during**: ruthmarks/add-wildflower-node — `EffectRuntimeGlobal` design
**Learning**: A wildflower-shaped global slot ("entry-point installs an `Effect.Runtime`, every other consumer reads it") has two consumer flavours: (a) sync readers that need it _now_ (`getEffectRuntimeOrThrow`) and (b) async readers that race the entrypoint and can wait (`getEffectRuntimeAsync`). A plain `let _runtime` works for (a) but forces (b) into a polling loop. `SubscriptionRef.make<T | undefined>(undefined)` collapses both: sync read uses `Effect.runSync(SubscriptionRef.get(ref))`, async read does `ref.changes |> Stream.filter(defined) |> Stream.take(1) |> Stream.runHead` — `changes` re-emits the current value to new subscribers, so already-populated reads resolve immediately while pre-population reads suspend until set. Tests reset via `SubscriptionRef.set(ref, undefined)` (now async, so test hooks `await` it). The sync setter still calls `Effect.runSync(SubscriptionRef.set(...))` for ergonomics — the underlying Effect is sync.
**Suggested destination**: docs/Effect/Patterns Reference.md

## Noun-focused modules + `export * as Namespace` mirror Effect's library surface

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: Splitting a "task-focused" file (`define-bridge.ts`, `transport.ts`, `testing.ts`) into noun-focused modules (`bridge.ts`, `bridge-transport.ts`, `message.ts`, `message-handler.ts`, `dispatch-error.ts`, `test-platform-adapter-layer.ts`) and re-exporting each as a namespace from the package barrel (`export * as Bridge from './bridge.ts'`) yields a consumer surface that reads like Effect's own (`Bridge.make`, `Bridge.Bridge`, `BridgeTransport.make`, etc.). The convention: file name = kebab-case noun; primary type alias = same name as the namespace (`Bridge.Bridge<...>`, `BridgeTransport.BridgeTransport<...>`); constructor = `make`; secondary types as flat exports inside the namespace (`Bridge.AnyBridge`, `Bridge.SenderIntersection`). User-defined `Context.Tag` classes are the exception — they stay as direct top-level exports (e.g. `TransportAdapter`) since they're values, not modules of types/functions, and `Layer.succeed(TransportAdapter, ...)` reads better than `Layer.succeed(TransportAdapter.TransportAdapter, ...)`.
**Suggested destination**: Strategies

## Generic test helpers belong in `kitchen-sink/test`; project-shape ones in slice testing subpaths

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging testing.ts move
**Learning**: When deciding where shared test helpers live, the question is "could a totally unrelated project reuse this?". Generic Effect/Logger plumbing (`makeCaptureLogger`, capturing-Layer factory, `runScoped` boilerplate, `expectWarningContaining` assertion) goes in `kitchen-sink/test` so any package — including ones in `global/` that must stay project-agnostic — can pull it without violating the layering rule. Wildflower-specific helpers (`installTestEffectRuntime` that touches the singleton runtime slot, anything that hard-codes a slice's contracts) belong in the relevant slice's `<slice>/testing` subpath. The wrong move is dumping everything into a single `effect-messaging-core/testing` and then watching test imports drag wildflower-specific helpers into a global package's tests — at which point you have to either inline duplicates everywhere or break the project-agnostic rule. Doing the split up front saves the retreat.
**Suggested destination**: Strategies

## Default-exported workspace-package modules need `{ __esModule: true, default: … }` jest mocks

**Discovered during**: ruthmarks/add-wildflower-node — gatekeeper bridge default-export migration
**Learning**: Switching a workspace-package subpath from named (`export { GatekeeperBridge }`) to default (`export default GatekeeperBridge`) breaks `jest.mock('package/subpath', () => ({ GatekeeperBridge: ... }))` silently — the mock factory has to mimic the ESM-default shape: `{ __esModule: true, default: ... }`. Without `__esModule: true`, jest's interop exposes the entire factory object as the default, and the consumer's `import GatekeeperBridge from '...'` ends up undefined. The named-export form needs no marker because there's no interop layer — the property name on the factory matches the import name directly. When migrating a slice's bridge to the default-export pattern (per the navigation-bridge.ts exemplar), audit `jest.mock('<slice>-core/bridge', ...)` factories at the same time.
**Suggested destination**: Strategies

## Vitest `test.projects` mode does not inherit root `resolve` config

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: Each path listed in root `vite.config.ts`'s `test.projects` loads its own `vite.config.ts` independently. Root-level `resolve.conditions: ['source']` does NOT propagate to project test runs. To pick up the `source` export condition during `vp test`, set `resolve.conditions: ['source']` on every per-package vite config (and on root, for `vp dev`/`vp build` from root context). Without this, sibling-package tests load each other's prebuilt `dist/`, masking source edits behind stale builds.
**Suggested destination**: Strategies

## Babel-jest transforms pnpm-symlinked workspace packages, breaking `@babel/runtime` resolution

**Discovered during**: ruthmarks/add-wildflower-node — gatekeeper-expo jest fix
**Learning**: Workspace deps installed via pnpm symlink resolve to `slices/.../dist/` rather than `node_modules/.../dist/`. The `transformIgnorePatterns` regex (matches `/node_modules/(?!...allow-list...)`) doesn't exclude these paths, so jest babel-transforms the dist file. The transformed CJS references `@babel/runtime/helpers/interopRequireDefault`, which fails to resolve from the workspace package's directory (no local `@babel/runtime`). Symptom: `TypeError: (0, _someWorkspacePkg.someExport) is not a function` (the require is throwing earlier in module init, so the consumer sees the function as undefined). Fix: in jest tests, `jest.mock('workspace-package', () => ...)` the workspace package wholesale rather than letting it be pulled in. Alternative: ship a Jest-only `moduleNameMapper` redirecting workspace-package paths to source.
**Suggested destination**: Strategies

## `Logger.replace` + capturing logger is the canonical test-logging pattern for Effect

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: For programs that emit `Effect.logWarning`, swap the default logger via `Logger.replace(Logger.defaultLogger, captureLogger)` and provide it as a layer (or install through `ManagedRuntime` for the global runtime slot). The replacement propagates via FiberRef into forked dispatch fibers automatically — no `Runtime.runSync` boundary at the test seam, no console-method spies. The capturing logger pushes `{ level, message }` records into a sink array; tests assert with an `expectWarningContaining(logs, substring)` helper. Beats `vi.spyOn(console, 'warn')` because Effect's logger backend isn't `console.warn` once a layer overrides it — the spy silently catches nothing.
**Suggested destination**: docs/Testing/Testing Reference.md

## Schema invariance escape hatch: `any` for internal bounds, `infer A` at boundaries

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure (`defineBridge`)
**Learning**: `Schema.Schema<X, I, R>` is invariant in `X`, so a precise schema is not assignable to a less-precise abstract bound (`Schema<{readonly _tag: 'X'}, string>` ↛ `Schema<unknown, string>`). To accept "any tagged JSON-encoded schema" inside a generic primitive's input bound, type it as `Schema.Schema<any, string, never>` — `any` is exempt from the variance check. Recover precise types at user-facing positions via `infer A` (a covariant extraction position) inside conditional types like `Pairs[I] extends readonly [infer Tag, infer S] ? S extends Schema.Schema<infer A, string, never> ? ...`. The `any` lives only inside the primitive's signature; user-visible inferred types never widen.
**Suggested destination**: docs/Effect/Patterns Reference.md

## jest-mock factory variable hoisting: `mock`-prefix only, no leading underscore

**Discovered during**: ruthmarks/add-wildflower-node — gatekeeper-expo / effect-messaging-expo jest tests
**Learning**: `jest.mock(path, factory)` factories are hoisted above imports and forbidden to read out-of-scope variables. `babel-plugin-jest-hoist` exempts identifiers matching `/^mock/i` (case-insensitive, _no leading underscore_). `__mockX` does NOT match the regex; `mockX` does. Captured-state variables that the factory writes (and the test body reads) must use a bare `mock` prefix — rename `let __captured = ...` → `let mockCaptured = ...` to satisfy the hoist guard.
**Suggested destination**: Strategies

## Pre-mount `<NavigateBinder navRef queue>` for module-load Effect handlers

**Discovered during**: ruthmarks/add-wildflower-node — embedded SPA navigation wiring
**Learning**: Module-load Effect handlers (a bridge `ReceiverLayer({ HostBackRequested, HostRequestedWebNavigation })` registered before any React mount) fire before `useNavigate()` is available. Pattern: a module-private `navRef: { current: ((to: number | string) => void) | null }` and a `queue: Array<-1 | string>`; handlers call through `navRef.current` if non-null, otherwise push to the queue. A `<NavigateBinder navRef={navRef} queue={queue} />` component mounted inside the router runs `useEffect` once, sets `navRef.current` to a wrapper around `useNavigate()`, and drains the queue. Lives as a generic component; aggregators wire their own ref + queue. Cleaner than threading `useNavigate()` into the layer construction (which has to happen before React exists).
**Suggested destination**: Strategies

## Bridge side discriminator: `'Host' | 'Web'`, never `'Native'`

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: For a cross-process WebView bridge, "Native" is the wrong word for the Expo side — it's overloaded (React Native vs JS, "native code" platform layer) and conflates with platform identity. Use `Host` for the side that hosts an embedded WebView, `Web` for the embedded page. Reserve "Native" for `react-native` library context. Names that follow the rename: `bridge.Host`, `'Host' | 'Web'` Side discriminator, `hostToWeb` / `webToHost` config keys, `HostBackRequested` / `HostRequestedWebNavigation` tags, `Navigation.Host.HandlerTag` Context.Tag identifier.
**Suggested destination**: Strategies

## `effect.Effect` namespace clash inside `jest.requireActual`

**Discovered during**: ruthmarks/add-wildflower-node — gatekeeper-expo jest mocks
**Learning**: `import * as React from 'react'` works for `requireActual<typeof React>('react')` because React is just a module. `import * as effect from 'effect'` _collides_: inside the factory body `effect.Effect` references both the namespace import (as a property on the `effect` namespace) and the `Effect` member, and the inferred type for `requireActual<typeof effect>('effect').Effect` lands in a confused state TS reports as `consistent-type-imports` lint errors. Use a renamed alias: `import type * as effectImportNamespace from 'effect'` and `jest.requireActual<typeof effectImportNamespace>('effect').Effect`. The `import type` form keeps the namespace at type-only, never reaches the runtime, and the renamed identifier dodges the property-vs-member ambiguity.
**Suggested destination**: Strategies

## `customConditions: ['source']` for TS-side workspace resolution

**Discovered during**: ruthmarks/add-wildflower-node — effect-messaging restructure
**Learning**: Mirror `resolve.conditions: ['source']` (vite) with `customConditions: ['source']` in each package's `tsconfig.json` (under `compilerOptions`, alongside `moduleResolution: 'bundler'` or `'nodenext'`). Without it, TS doesn't follow the `source` export condition and resolves workspace deps through `default` (the dist), giving stale type info during edits — even when vite/vitest see the source. The two settings are separate: vite's `resolve.conditions` covers runtime resolution; tsconfig's `customConditions` covers type resolution. Set both, on every package.
**Suggested destination**: Strategies

## 2026-05-08 — Bridge primitive + web transport (interop slice)

From the `defineBridge` + `makeWebTransport` refactor in `slices/interop/`. Patterns and gotchas worth remembering:

- **Effect `Schema.Schema<A, I, R>` is invariant in `A`.** A precise `Schema<{_tag: 'X'}, ...>` is _not_ assignable to `Schema<unknown, ...>`. Two escapes: (1) `Schema<any, ...>` in _internal_ constraint slots, with the `any` never leaking because user-visible types are extracted via `infer A` (covariant position) at the boundary; (2) per-pair conditional checks where `Tag` is inferred from position 0 of a tuple, so `S extends Schema.Schema<infer A, ...>` only ever runs against a concrete literal. Effect ships `Schema.Schema.AnyNoContext = Schema<any, any, never>` for this same reason.

- **`Context.Tag<in out Id, in out Value>` is invariant in both slots.** A concrete `Tag<'X.Web.HandlerTag', HandlersFor<...>>` does NOT extend a parameterised 'Tag<`${string}.Web.HandlerTag`, ...>' even with `any` for Value. To admit concrete tags through a structural bound, both slots must be`any`. Consequence: two `defineBridge` calls with the same`name`produce _type-equivalent_ but _runtime-distinct_ tags — TS can't catch accidental name collisions, but runtime`Context.GenericTag`instances differ so unrelated bridges never confuse. Same trade-off`Context.Tag` makes elsewhere in this repo.

- **`Layer<in ROut, ...>` contravariance + Effect's `never` trick.** `Layer.mergeAll` uses `readonly [Layer<never, any, any>, ...]` as its variadic bound. Contravariance flips so every concrete `Layer<X>` is assignable to `Layer<never>`. The same idiom applies to function inputs: when a structural bound needs to admit "any sender function" (some with concrete unions, some with empty `never`), put `never` in the contravariant slot — `(m: never) => void` admits both `(m: ConcreteUnion) => void` and `(m: never) => void`.

- **`infer` preserves concrete generics through abstract bounds.** Inside a generic function body, `Bridges[I]['Web']['HandlerTag']` resolves to the bound (`Tag<any, any>`), not the call-site type. To recover the precise `Id`, do a conditional at the type-derivation site: `Bridges[I] extends { readonly Web: { readonly HandlerTag: Context.Tag<infer Id, any> } } ? Layer.Layer<Id> : never`. The `infer` runs against the concrete passed-in `Bridges[I]`, so the precise tag survives. Same idea recovers per-bridge SenderType via `infer F` on `makeSender`'s return.

- **Function-intersection senders need narrowing at call sites.** TS treats `((a: A) => void) & ((b: B) => void)` as overloads — callable with A or B individually — but does NOT synthesise an intersection from a `(m: A | B) => void` implementation. Two consequences: (1) building an intersected sender from a union-argument runtime requires one `as` cast at the boundary; (2) calling the intersected sender with a discriminated-union value fails ("No overload matches this call") because TS can't pick — the caller must narrow first (`if (msg._tag === 'X') sender(msg)`).

- **`vp-test` + `jsdom` resolution: workspace-level breakage.** `vite-plus` installed globally cannot resolve `jsdom` from a slice's `node_modules`. Adding `jsdom` as a devDep does NOT help — vp-test fails with "Cannot find package 'jsdom' imported from .../vite-plus/...". Reproduces across `global/react-tundraish` and any slice using `environment: 'jsdom'`. Pre-existing on the `ruthmarks/add-wildflower-node` branch; unrelated to bridge work, but worth knowing — `vp check` is the only verification axis available for browser-DOM tests today.

- **Phantom-value sentinel pattern.** When a returned object needs type-carrying properties (so consumers can `typeof Bridge.Web.SenderType` etc.), a single module-scope `const PHANTOM = undefined as never` satisfies any property-typed slot via contextual typing of the surrounding interface. One oxlint-disable at the sentinel definition; no per-property casts needed.

- **`Schema.Enums` as a dual-purpose namespaced constant.** `const Surface = { key, Schema: Schema.Enums({ Expo: 'expo' }) } as const` paired with `Schema.decodeUnknownOption(Surface.Schema)(value).pipe(Option.getOrNull)` gives runtime validation + a clean `typeof Surface.Schema.Type` for type-only consumers. Replaces a `SURFACE_KEY` + `SURFACE_EXPO` + type-alias trio with one namespaced object.

- **Tuple-mapped layers enforce per-position pairing.** `bridges: Bridges` (tuple) + `layers: { readonly [I in keyof Bridges]: Layer.Layer<Context.Tag.Identifier<Bridges[I]['Web']['HandlerTag']>> }` enforces that the I-th layer satisfies the I-th bridge's tag. Mismatched lengths or wrong-bridge layers are compile errors. Better than a homogeneous `ReadonlyArray<Layer<Union>>` because the latter can't catch a missing layer for any specific tag.

## Slice-level bridge tests earn their keep on cross-side alignment, not library-primitive round-trips or parent-package shape duplication

**Discovered during**: ruthmarks/add-wildflower-node — review of [slices/navigation/navigation-core/tests/bridge.test.ts](../../slices/navigation/navigation-core/tests/bridge.test.ts)
**Learning**: A slice's bridge test file landed at 16 tests / 151 lines, but only the last two earned their keep. The per-schema round-trip tests (L6-75) re-test `Schema.parseJson(Schema.TaggedStruct(...))` — a library primitive — three times for HostBackRequested / HostRequestedWebNavigation / RouteChanged. The shape assertions (L78-122) — `Object.keys(Host.OutboundSchemas)`, `HandlerTag.key === 'Navigation.Host.HandlerTag'` — duplicate the equivalent tests already covered in the parent `effect-messaging-core` package one layer down. The valuable tests (L123-150) exercise cross-side alignment via the test adapter: `NavigationBridge.Host.send(...)` then `Schema.decodeSync(NavigationBridge.Web.InboundSchemas.X)(sentSink[0])`. Heuristic when auditing slice-level test files: keep tests that exercise contracts unique to the slice (cross-side schema pairing, slice-specific options-shape honoring by an aggregator's encoding logic, e.g. `hostOptionsShape: { initialPath }` flowing through the Expo wiring); drop tests that re-test library primitives or re-assert parent-package invariants. The budget freed by dropping the duplicates should fund tests on slice-specific encoding behaviour the parent package can't possibly cover.
**Suggested destination**: docs/Testing/Testing Reference.md

## 2026-05-08 — interop slice planning

- **Aggregation pattern (livestore-style) generalises beyond livestore.** `apps/wildflower-server/src/schema.ts` spreads `{tables, events, materializers}` from each slice's `<slice>-core/livestore/index.ts`. Mirror this shape (named exports + spread-merge in the host) for any new cross-slice primitive — messages, routes, contexts, etc. The user explicitly named this as the pattern to emulate.
- **Where collector source lives.** On `main` / `ruthmarks/add-wildflower-node` the `slices/collector/*` packages are `dist/`-only — no `src/`. Live source is on `ruthmarks/add-fhir-server`. Check that branch before concluding the slice is empty or stub.
- **`apps/wildflower-react` is the embedded SPA**, not a standalone site — it's loaded inside Expo's WebView and uses `MemoryRouter` (never `BrowserRouter`). It owns mounting; slices contribute `routesFragment` exports that the app spreads. Slice `*-react` / `*-web` packages should NOT ship their own `main.tsx` even though some currently do; the destination is wildflower-react owns mounting.
- **Duplication-as-signal.** When the same boundary-crossing wiring (e.g. `host-bridge.tsx`) appears byte-identical in 2+ slices, treat it as a strong "extract to shared slice" signal — not per-slice glue. The fhir-server branch had three identical copies.
- **Plan-mode handoff convention.** When planning a refactor for another agent to execute, write the final plan to `/workspaces/wildflower/Plan.md`. Make it self-contained: absolute or workspace-relative paths, explicit branch references at each ambiguity, concrete code examples for non-trivial APIs, an itemized Move/Rewrite/Add critical-files section that implicitly conveys execution order.
- **Premature-abstraction antipattern in planning.** When proposing a new abstraction, enumerate the concrete use cases _first_ and let the user name the concept _after_ seeing them. My first interop draft conflated four distinct concerns under "Bootstrap" (window-globals, URL params, auth-token handoff, postMessage protocol); the user pushed back, we re-decomposed each case, and landed on a cleaner "everything is Messages" framing. Lesson: AskUserQuestion is most useful for naming/scoping _after_ enumeration, not for a priori category proposals.
- **Project messaging idiom.** Cross-process data uses `_tag`-keyed Effect schemas via `Schema.parseJson(Schema.TaggedStruct(tag, ...))`, sent through a buffered `MessageHandler<Receive, Send>`. Past-tense / event-style naming (`AuthTokenIssued`, `RouteChanged`, `ResponseStarted`) — never imperative (`AnnounceAuthToken`, `SetRoute`). Each slice exports two directional records `<Slice>NativeToWeb` / `<Slice>WebToNative`; per-platform `Context.Tag`s use distinct names (`<Slice>WebMessageHandler` / `<Slice>ExpoMessageHandler`).
- **`global/expo-tundraish` housed `EmbeddedWebView`** even though that's a cross-process-communication concern, not themed UI. The interop refactor relocates the WebView pieces; themed components stay. Pattern: when a `global/` package starts mixing concerns, look for a `slices/` extraction.

## Test-file type-check of new kitchen-sink subpath needs a built dist

**Discovered during**: ruthmarks/migrate-wildflower-expo — adding `kitchen-sink/livestore` and consuming it from slice `tests/`
**Learning**: Slice `tsconfig.json` files only `include: ["src"]`. `vp check` still type-checks `tests/**/*.test.ts` (via the lint runner), but because tests sit outside the include they don't inherit `customConditions: ['source']`. That means imports like `import { defineSliceLivestore } from 'kitchen-sink/livestore'` are resolved against the `default` export path (`./dist/livestore.js`) rather than the `source` path (`./src/livestore/index.ts`). If kitchen-sink hasn't been built, the test sees `defineSliceLivestore` as `any`, every class extending its `StoreTag<Self>()` collapses, and `typeof MyStore.Service` errors with `Property 'Service' does not exist on type 'typeof MyStore'` — even though `src/` checks pass. Fix: run `vp run build` (or `vp run -F kitchen-sink build`) once after adding a new kitchen-sink subpath export, before re-running `vp check`. The same caveat applies to any new subpath added to a `global/` package consumed cross-package by tests.
**Suggested destination**: docs/Testing/Testing Reference.md or a vp-pack reference.

## Drop a squash-merged local commit via `git rebase --onto main <commit-to-drop> <branch>`

**Discovered during**: ruthmarks/05-tunnel-node — rebasing after PR #41 (tunnel-react) was squash-merged into main
**Learning**: When a feature branch's predecessor commit landed on main as a squash-merge, a plain `git rebase main branch` will try to re-apply that commit and conflict against the (often improved) merged version. Instead, use `git rebase --onto origin/main <commit-to-drop> <branch>` — replays only the commits _after_ `<commit-to-drop>` onto `origin/main`. In this case PR #41's merged version had been refactored to consume PR #45's lifted react-tundraish primitives, so replaying the local b019e18 (`feat: add tunnel-react slice`) would have created a thicket of conflicts against files that no longer existed in that location. Dropping it via `--onto` reduced the rebase to a single `pnpm-lock.yaml` conflict on the next commit.
**Suggested destination**: Strategies

## pnpm-lock conflicts during rebase: take one side, then `vp install` to regenerate

**Discovered during**: ruthmarks/05-tunnel-node — rebase onto main with a new tunnel-node package.json
**Learning**: When `pnpm-lock.yaml` conflicts during a rebase, don't hand-merge — the lockfile is a derived artifact. Run `git checkout --ours pnpm-lock.yaml && git add pnpm-lock.yaml` (in a rebase, "ours" = the new base / upstream side), then `vp install` from the repo root; pnpm reconciles the lockfile against the merged set of `package.json` files. `git status` will then show pnpm-lock.yaml as modified-but-staged-stale — re-`git add` it before `git rebase --continue`. Works the same whether you take ours or theirs; the install pass is what makes it correct.
**Suggested destination**: Strategies

## The harness's primary cwd may sit in a worktree on a different branch than the target

**Discovered during**: ruthmarks/05-tunnel-node — operating from a different worktree
**Learning**: An agent's "primary working directory" can be a worktree pointing at a branch other than the one the user is asking about. Check `git worktree list` before checking out, rebasing, or committing — the target branch is often already owned by a different worktree, and `git checkout` will fail with "already checked out at …". Run with `git -C <owning-path> <subcommand>` or `cd` to that worktree.
**Suggested destination**: Strategies

## `*SettingsItemsFragment` + `*SettingsRoutesFragment` — slice-react convention for cross-cutting settings

**Discovered during**: ruthmarks/settings-screen — issue #47
**Learning**: Slices that contribute to the unified `/settings` surface export two named fragments from their `*-react` package: a `JSX.Element` route fragment (paths under `/settings/<slice>/`) and a `readonly SettingsItem[]` items fragment (menu entries). `apps/wildflower-react/src/screens/settings-screen.tsx` concatenates every slice's items fragment in declaration order and feeds the result to `<ItemList>`; `apps/wildflower-react/src/routes.tsx` mounts the route fragments as siblings alongside `<SettingsScreen />`. No runtime registry, no provider — pure compile-time composition mirroring the existing `*RoutesFragment` pattern. `SettingsItem` lives in `shared-structures-react` as the `href`-required branch of `ItemListItem` from `react-tundraish` so items pass straight through with no transformation. Gatekeeper's three-fragment split (`gatekeeperOpenRoutesFragment` / `gatekeeperAuthenticatedRoutesFragment` for externally-published OAuth + RFC 8628 device-flow URLs that MUST stay at `/gatekeeper/*` / `gatekeeperSettingsRoutesFragment` for the owner landings that move to `/settings/gatekeeper/*`) is the template for any slice that mixes settings-shaped landings with externally-linked routes. The fragment names use `Open` (no auth required) / `Authenticated` (auth-gated, in slice URL space) / `Settings` (auth-gated, under `/settings/`) — avoid "flow" as a fragment label; that word belongs to OAuth/RFC 8628 protocol-flow vocabulary, not routing buckets.
**Suggested destination**: docs/UI/Settings Fragments How-To.md (already lives there)

## `jest.mock` factories can't close over module-scope `const`s — babel-jest hoists requires above the body

**Discovered during**: ruthmarks/host-bindings-parallel-arrays — fixing wildflower-expo Jest suite after the HostBindings refactor
**Learning**: When a `jest.mock(id, () => ({...}))` factory references a `const`/`let` declared at module scope, the variable is `undefined` at factory-call time. babel-jest (via `babel-plugin-jest-hoist`) hoists `jest.mock` calls to the very top of the compiled file, and `@babel/plugin-transform-modules-commonjs` hoists ESM `import`s to the next position — both above the file body. So when the require chain (triggered by a hoisted `import` like `import { AppShellWebView } from './app-shell-webview.tsx'`) calls the factory, the body hasn't executed yet. Fix: inline literal sentinels inside the factory (`{ kind: 'localOrigin$' }`) and discriminate at _call time_ inside any returned closure (e.g. a `useQuery` mock that branches on `q.kind`). The `mock`-prefix convention only matters for `let`s read lazily by a closure body, never values consumed at factory-call time. Repo example: `apps/wildflower-expo/src/app-shell/app-shell-webview.test.tsx` mocks `local-http-server-core/livestore` and `gatekeeper-core/livestore` with `{ kind: '...' }` sentinels and a `useQuery` that narrows via `'kind' in q`.
**Suggested destination**: docs/Testing/Unit Testing How-To.md

## `vp run jest` fails on `@livestore/*` ESM in Expo packages — mock the slice livestore entry instead of widening `transformIgnorePatterns`

**Discovered during**: ruthmarks/host-bindings-parallel-arrays — fixing wildflower-expo Jest suite
**Learning**: `@livestore/livestore`'s `dist/mod.js` is native ESM (`export { ... }`), and `jest-expo`'s default `transformIgnorePatterns` doesn't allow-list it — so any test that transitively imports a slice's `<slice>-core/livestore` entry blows up at parse with `SyntaxError: Unexpected token 'export'`. The repo convention (already used in `apps/wildflower-expo/src/components/app-runtime-provider.test.tsx`) is to mock the slice's livestore entry directly: `jest.mock('<slice>-core/livestore', () => ({ <NamespaceUsedByCode>: ... }))`. Don't extend `transformIgnorePatterns` to cover `@livestore/*` — it slows tests and pulls native runtime code (e.g. `@livestore/react`'s adapters) into the Jest VM. The same approach covers `local-http-server-core/livestore`, `gatekeeper-core/livestore`, `tunnel-core/livestore`, etc.
**Suggested destination**: docs/Testing/Unit Testing How-To.md
