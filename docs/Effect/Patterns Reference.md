# Effect Patterns Reference

Effect-TS conventions used in this codebase.

## Effect Generators

Use generator syntax for composition:

```typescript
export const createEncounter = (args: CreateEncounterArg) =>
  Effect.gen(function* () {
    const repo = yield* EncounterRepository
    return yield* repo.create(args)
  })
```

## Pattern matching on type and value together

`Match.when` accepts a structural object pattern that tests fields by literal equality on the runtime input, and narrows the matched field to that literal in the handler. So one `Match.when({ error: 'access_denied' }, (body) => …)` arm matches anything where `body.error === 'access_denied'` and gives the handler `body.error` narrowed to `'access_denied'` — type _and_ value dispatch in a single clause, no inner `if`.

- Pair it with `Match.withReturnType<T>()` to pin the matcher's overall result type. Each arm then reads as "this shape" → "this outcome" on one line, and adding a case is one new `Match.when`.
- Order arms most-specific to least-specific, ending in `orElse`.
- For cases broader than a single literal, use a schema predicate as the pattern: `Schema.is(SomeSchema)`, or `Predicate.or(Schema.is(A), Schema.is(B))`.
- When schemas are uniquely structured by a literal-typed discriminator field, match on the field directly — a custom `Predicate.and(Schema.is(...), hasErrorCode(literal))` helper is unnecessary.

## Context, Tags, and Services

### `Context.Tag['Type']` is the service type — drop the parallel `XxxShape` interface

`class Tag extends Context.Tag('...')<Tag, Service>() {}` makes `Tag['Type']` an alias for `Service`. Anywhere a consumer would reach for a separately-exported `TagShape` interface, index the Tag instead. This retires the `interface PlatformAdapterShape { … }` + `class TransportAdapter extends Context.Tag('…')<TransportAdapter, PlatformAdapterShape>() {}` dual-export pattern in favour of one declaration and one source of truth. Callers authoring custom adapter values type them as `TransportAdapter['Type']`. This works wherever the `Context.Tag` is the value-bearing type and the sibling interface exists only to seed the second type parameter.

### Bake an internal context requirement to reshape the public type

When a higher-order surface has internal callbacks that require a `Context.Tag` (e.g. each bridge's per-tag sender needs `TransportAdapter`), the natural typing leaks that requirement onto every public call — `transport.sendMessage(m): Effect<void, never, TransportAdapter>` instead of `Effect<void>`.

Keep the consumer-visible type clean by resolving the Tag once at construction time inside the scoped Effect, then satisfying the inner callbacks with `Effect.provideService(Tag, value)` at the boundary. Tests still swap implementations by providing a different value via `Layer.succeed(Tag, stub)` to the constructor itself; only the _public closure_ hides the requirement. Reach for this whenever "this thing internally needs X, but consumers shouldn't have to provide X on every call".

The importer slice does the same with schemas rather than callbacks: `importer-fundamentals`' source-file schemas carry a `SourceFile.Format` requirement, and `DecodeFunction.make` provides it from the `sourceFileFormat` the binding handed it, so the batch `decode` it returns requires nothing. The tag's only other providers are the shell's two reads of a stored archive, each from the same registry entry's constants — which is what keeps a format's coding spelled once. A constructor that closed over the constants instead would let two copies disagree.

## `SubscriptionRef` for a set-once, observable runtime slot

A global slot where an entry point installs a value once and every other consumer reads it (e.g. `EffectRuntimeGlobal`) has two consumer flavours: sync readers that need it _now_, and async readers that race the entry point and can wait. A plain `let _value` serves the first but forces the second into a polling loop. `SubscriptionRef.make<T | undefined>(undefined)` collapses both:

- **Sync read**: `Effect.runSync(SubscriptionRef.get(ref))`.
- **Async read**: `ref.changes` piped through `Stream.filter(defined)`, `Stream.take(1)`, `Stream.runHead`. `changes` re-emits the current value to new subscribers, so already-populated reads resolve immediately while pre-population reads suspend until the value is set.
- **Reset (tests)**: `SubscriptionRef.set(ref, undefined)` — now an Effect, so test hooks `await` it.

The sync setter can still call `Effect.runSync(SubscriptionRef.set(...))` for ergonomics, since the underlying Effect is synchronous.

## Schema

### Invariance escape hatch: `any` for internal bounds, `infer A` at boundaries

`Schema.Schema<A, I, R>` is invariant in `A`, so a precise schema is not assignable to a less-precise abstract bound (`Schema<{ readonly _tag: 'X' }, string>` is not a `Schema<unknown, string>`). To accept "any tagged JSON-encoded schema" inside a generic primitive's input bound, type that slot as `Schema.Schema<any, string, never>` — `any` is exempt from the variance check. Recover precise types at user-facing positions with `infer A` (a covariant extraction position) inside conditional types, e.g. `Pairs[I] extends readonly [infer Tag, infer S] ? (S extends Schema.Schema<infer A, string, never> ? … : …) : …`. The `any` lives only inside the primitive's signature; user-visible inferred types never widen. Effect ships `Schema.Schema.AnyNoContext = Schema<any, any, never>` for this same reason.

### Widen `Schema.Literal` to `Schema.String` for `State.SQLite.text()` columns

When an HTTP response Schema uses `Schema.Literal(...)` for a field backed by a `State.SQLite.text()` column, `store.query(...)` won't type-check — the row's field is typed `string`, not the narrow union. Widen the response schema to `Schema.String` rather than projecting rows through a cast; the DB genuinely holds unconstrained strings.

### `Schema.declare` combinators need `arbitrary` + `equivalence` annotations

A `Schema.declare(...)`-based combinator (e.g. kitchen-sink's `OrNullAsOptional`/`OrNullAsUndefined`, fhir-r4's choice-slot null stub) derives nothing on its own: `Arbitrary.make` throws `MissingAnnotation`, and `Schema.equivalence` silently falls back to reference equality — so a schema-equality assertion reports "Values are not schema-equivalent … no visual difference" for structurally identical values. This stays hidden while tests generate and compare through plainer sibling schemas, then fails en masse the moment the declared combinator is the only schema tree (as it did porting the fhir-r4 tests onto the wire schemas).

Ship both annotations from day one — declaration annotations receive the type-parameters' derived arbitraries/equivalences as arguments:

```typescript
Schema.declare(/* … */).annotations({
  arbitrary: (inner) => (fc) => fc.oneof(fc.constant(null), inner(fc)),
  equivalence: (inner) => (a, b) => (a === null || b === null ? a === b : inner(a, b)),
})
```

Fix it on the combinator, not per call-site. Rule of thumb: any new `Schema.declare` that can appear inside a property-tested schema ships with `arbitrary` + `equivalence`. See [Property Testing Reference](../Testing/Property%20Testing%20Reference.md) for how these feed `Arbitrary.make` and schema-equality assertions.

## Value equality: `Equal.equals` needs the class to implement `Equal`

`Equal.equals(a, b)` never type-errors on a class that doesn't implement `Equal.Equal` — it falls back to reference equality, so two structurally identical instances compare `false`. A membership check like `draft.unknown.some(Equal.equals(scope))` then type-checks, reads as idiomatic, and always returns `false` (parsed instances are never reference-equal) — turning a toggle into an append-duplicates bug.

Before using `Equal.equals` against a domain class, verify the class (or its base) implements `[Equal.symbol]`/`[Hash.symbol]`. When adding a new sibling variant to a family whose other members are value-comparable, implement `Equal`/`Hash` on it at the same time (compare `kind` + payload, mirroring the siblings). The fix belongs in the domain class, not at the call site — a serialize-and-compare workaround at the call site is the smell that the class is missing `Equal`.

Real case: `scopes-core`'s `UnknownScope` was the one member of its scope family that shipped without `Equal` — its `KnownScope`, context (via the `Context` base), and resource-type siblings had it — so a draft-membership check over the `unknown` scopes silently never matched. It now implements `Equal`/`Hash` like the rest.

## `HttpApiClient` usage

### Client methods return `Effect`, not `Promise`

Methods produced by `HttpApiClient.make(Api, { baseUrl })` return `Effect.Effect<A, E, R>` — `await`-ing one directly trips oxlint's `await-thenable`. Wrap the runtime with a helper and call through it:

```ts
const runAuth = async <A, E>(f: (c: Client) => Effect.Effect<A, E, R>): Promise<A> =>
  runtime.runPromise(f(await clientPromise))

// call site
await runAuth((c) => c.group.Method(args))
```

The same pattern applies to any `HttpApiClient`-produced client across the repo.

### Derive response types from Schemas, not from `ReturnType<Client[G][M]>`

`HttpApiClient` methods carry a `<WithResponse extends boolean = false>` generic. `ReturnType<Client['group']['method']>` without instantiation produces a three-way union `Effect<A | HttpClientResponse | [A, HttpClientResponse], …>` that can't be narrowed structurally — Unwrap helpers over it resolve to `unknown`. Instead, export the original `Schema.Struct` from the API-definition package and derive client-side types as `Schema.Schema.Type<typeof Schema>`. This is stable across client refactors and keeps web and server types tied to the same source.

### Multiple `topLevel: true` groups collide in the client type

`HttpApiClient.make(Api, …)` hoists every endpoint of any `{ topLevel: true }` group to the client root, so same-named endpoints from different groups (e.g. `Collection`, `Create` on both `Patient` and `Observation`) collide, last-added winning. See [HttpApi Composition How-To](./HttpApi%20Composition%20How-To.md#avoid-multiple-toplevel-true-groups-under-one-httpapi) for the failure shape and the three workarounds (drop `topLevel`, one client per single-group `HttpApi`, or raw `fetch`).

### A 200 with a non-JSON body surfaces as `ParseError: Could not parse JSON`

When a server uses a catch-all SPA fallback (`Router::fallback(serve_spa_fallback)` in axum, or any equivalent), a request to an API route the server doesn't implement returns `index.html` with status **200**. `HttpApiClient` matches the success status, tries to `JSON.parse` an HTML document, and fails with `ParseError: … Could not parse JSON` against the endpoint's success schema. The error's schema chain — `((unknown <-> string) <-> (string <-> unknown)) <-> <SuccessSchema>` — is the client's body-text→JSON step; recognize that shape as "the server sent a 200 non-JSON body" (almost always the SPA fallback swallowing an unimplemented route), not schema/codec drift.

- **Diagnose** with `curl -i http://127.0.0.1:8080/<route>` — a `200` plus an HTML body confirms it.
- **Mind wire prefixes** when stubbing the missing route: a group with `.prefix('/collector')` serves `ListRemotes` at `/collector/remotes`, not `/remotes`.
- Worked case: the Tauri host's Rust server (`apps/wildflower-tauri/src-tauri/src/lib.rs`) served only gatekeeper + FHIR, so `GET /apps`, `/tunnel`, `/collector/remotes` (implemented only in the TS `wildflower-server`) fell through to the fallback and crashed the webview.

### `HttpApiSchema.withEncoding` on a `Schema.Union` payload

Two traps sit in one schema:

1. **Annotate each union member, not the union.** Piping `HttpApiSchema.withEncoding({ kind: 'UrlParams', … })` onto a `Schema.Union(...)` payload wrapper makes the **server** (`HttpApiBuilder`) decode form-urlencoded correctly, but the **client** (`HttpApiClient`) resolves payload encodings _per union member_ — the wrapper-level annotation is silently ignored and requests go out as `application/json`. TS↔TS this is invisible (the lenient Effect server accepts JSON), but a strict RFC 6749 server (e.g. gatekeeper-rust, `serde_urlencoded` only) rejects it with `400 invalid_request`. Fix: pipe `withEncoding` onto **each member**, leave the union bare. Pin it with a capturing-`HttpClient` test that asserts the request body's content type and raw text (`gatekeeper-core/src/http-api-definition/oauth.test.ts`) — write that test _before_ the fix to confirm the diagnosis.
2. **Don't hoist the annotation into a shared const.** `withEncoding` is generic over the schema it's applied to; a hoisted `const enc = HttpApiSchema.withEncoding({...})` pins those type parameters to `unknown`, which leaks `R = unknown` into the whole `HttpApi`'s requirements channel and surfaces as baffling `Layer<…, never, unknown> is not assignable to Layer<…, never, never>` errors in distant wiring. Write the `.pipe(HttpApiSchema.withEncoding({...}))` call out at each use site.

## Tracing: spans only emit if the running fiber carries the tracer

`Effect.withSpan` produces an OTel span only when the _running fiber_ has the tracer in its FiberRef (set by `@effect/opentelemetry`'s `OtelEffectTracer.layerGlobal`). Code that runs inside a `forkScoped`/`forkDaemon` fiber — e.g. an inbound-dispatch fiber or step-timers — inherits FiberRefs as a **snapshot taken at fork time**, so span calls there are silent no-ops unless the tracer was already in context when the fork happened.

Fix: provide the telemetry layer to the effect that builds/forks those fibers, at boot — e.g. `Effect.provide(webTelemetryLayerFromEnv())` around the transport build in `apps/wildflower-react/src/bridges/build-transport.ts`. The forked fibers then snapshot it. The effect does **not** need the tracer in its `R`: providing the layer sets the FiberRef as a side effect, and the per-fiber copy survives even after the provide-scope closes.

Caveat for focused tests: `webTelemetryLayerFromEnv()` is not pure even on the disabled path — `makeClientTelemetryLayer` calls `initClientTelemetry` eagerly at layer-_construction_ time, installing the global OTel `StackContextManager` that `telemetry-web` injects and initialising Sentry _before_ the `isTelemetryEnabled` check returns `Layer.empty`. A focused unit test that drives such a boot path with everything else mocked must also mock it away: `vi.mock('telemetry-web', () => ({ ...actual, webTelemetryLayerFromEnv: () => Layer.empty }))` — otherwise those global side effects perturb microtask timing and leak OTel/Sentry globals across tests. `initClientTelemetry` is idempotent, so calling it from the boot path in addition to app-boot init is safe in production.

## See Also

- [Learnings Inbox](../Agents/Learnings%20Inbox.md) — Project-specific Effect/HttpApi gotchas discovered during recent work
