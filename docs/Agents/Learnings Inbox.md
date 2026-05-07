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
