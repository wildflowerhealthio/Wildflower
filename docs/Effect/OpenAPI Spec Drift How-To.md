# OpenAPI Spec Drift How-To

How to put a slice's HTTP wire contract under the cross-language drift check, so
the Rust/axum server (`utoipa`) and the TypeScript Effect `HttpApi` client can't
silently disagree.

## What the check is

Each slice with an HTTP surface commits an OpenAPI **snapshot** emitted by its
Rust routes, and two tests pin it from both sides:

- a **Rust snapshot test** proves the committed JSON matches what `utoipa` emits
  from the live axum routes (so the snapshot can't go stale vs the server), and
- a **TS drift test** proves the slice's Effect `HttpApi` matches that same JSON
  on wire shape (field presence, required-ness, primitive kind, union arity).

The generic comparison engine lives in
[`shared-structures-core/openapi-drift`](../../slices/shared-structures/shared-structures-core/src/openapi-drift/index.ts)
(`collectSpecDrift` — a _compatibility_ policy: "can this client talk to this
server?", not a full diff). The shared test harnesses are
[`shared-structures-core/openapi-drift/testing`](../../slices/shared-structures/shared-structures-core/src/openapi-drift/testing.ts)
(`defineSpecDriftTest`) and
[`shared-structures-rust`'s `openapi_snapshot`](../../slices/shared-structures/shared-structures-rust/src/openapi_snapshot.rs)
(`assert_up_to_date`). `gatekeeper` and `tunnel` are the worked examples.

The `api-sync` CI workflow runs **both** halves whenever either side changes, so
a one-sided change can't slip drift past the per-language `Rust` /
`TypeScript` CI workflows. It is project-agnostic — the steps below need **no
workflow edit**.

## Add a slice (Rust side)

In `slices/<slice>/<slice>-rust`:

1. Add `utoipa.workspace = true` and `utoipa-axum.workspace = true` to
   `[dependencies]`, and the shared helper to `[dev-dependencies]`:
   `shared-structures-rust = { path = "...", features = ["openapi-snapshot"] }`.
2. `#[derive(ToSchema)]` on the wire types. For a field that is `Option<T>` but
   **always serialized** (no `#[serde(skip_serializing_if)]`), add
   `#[schema(required)]` — it's required-on-the-wire, and this overrides
   utoipa's Option-implies-optional default to match a TS `Schema.NullOr`.
   utoipa 5.5 parses `#[schema(required)]` as a bool-or-true flag, so the bare
   attribute reads as `required = true`.
3. `#[utoipa::path(...)]` on each handler (method + `path` + `responses` +
   `request_body`), and assemble them with `utoipa_axum`'s `OpenApiRouter` +
   `routes!` so the spec is collected from the same routes that serve traffic
   (see `gatekeeper-rust`/`tunnel-rust` `http/mod.rs` → `documented_router()`).
4. Add the snapshot test, delegating to the shared helper with the **shared
   name** so CI's workspace-wide run picks it up:

   ```rust
   const SPEC_PATH: &str =
       concat!(env!("CARGO_MANIFEST_DIR"), "/openapi/<name>.openapi.json");

   #[test]
   fn openapi_spec_snapshot_is_up_to_date() {
       shared_structures_rust::openapi_snapshot::assert_up_to_date(&openapi_spec(), SPEC_PATH);
   }
   ```

5. Generate the committed snapshot (it's git-tracked and oxfmt-ignored via the
   `**/openapi/*.openapi.json` glob, so it stays byte-exact with serde_json):

   ```bash
   mkdir -p slices/<slice>/<slice>-rust/openapi
   UPDATE_OPENAPI=1 cargo test -p <slice>-rust openapi_spec_snapshot_is_up_to_date
   ```

## Add a slice (TS side)

In `slices/<slice>/<slice>-core`, add `shared-structures-core` to
`devDependencies` and a `*.openapi-drift.test.ts` (the filename must contain
`openapi-drift` so CI's `vp test openapi-drift` matches it):

```ts
import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { MyApi } from './index.ts'

defineSpecDriftTest({
  name: 'my slice',
  serverSpec: new URL('../../../<slice>-rust/openapi/<name>.openapi.json', import.meta.url),
  clientApi: MyApi,
  scope: [
    ['/my/path', 'get'],
    ['/my/path', 'put'],
  ],
  // Optional: `responsesNotCompared` for endpoints whose response is not a JSON
  // contract (e.g. a browser 302 / HTML page) — their params/body still compare.
})
```

## Gotchas

- **`Schema.Int`, not `Schema.Number`, for Rust `i64`/`i32`.** The engine treats
  OpenAPI `integer` and `number` as distinct kinds; `utoipa` emits `i64` as
  `integer`, and `Schema.Number` emits `number` → drift. A JSON number is a JSON
  number on the wire, but the spec types must agree.
- **Nullability is ignored; required-ness is not.** `["string","null"]`
  normalizes to `string`; what matters is whether the field is in `required`.
  Match a `Schema.NullOr` (required key, nullable value) with `Option<T>` +
  `#[schema(required)]`; match a `Schema.optionalWith` (optional key) with a
  plain `Option<T>` (utoipa's default).
- **Regenerate, don't hand-edit, the snapshot** — `UPDATE_OPENAPI=1 cargo test
-p <slice>-rust openapi_spec_snapshot_is_up_to_date`. The committed JSON must
  stay byte-exact with `serde_json::to_string_pretty` (the Rust snapshot test
  asserts equality), which is why it's excluded from oxfmt.
- **Keep `defineSpecDriftTest` generic over `fromApi`'s `<Id, Groups, E, R>`.**
  A materialized supertype like `HttpApi.HttpApi.Any` is _not_ assignable from a
  concrete `HttpApi`, so the shared TS factory must stay generic over the API's
  type parameters rather than narrowing its `clientApi` to `HttpApi.HttpApi.Any`
  — otherwise concrete slice APIs won't type-check against it.

## See also

- [HttpApi Composition How-To](./HttpApi%20Composition%20How-To.md) — composing
  slice `HttpApiGroup`s into a parent `HttpApi`.
- [Testing Reference](../Testing/Testing%20Reference.md).
