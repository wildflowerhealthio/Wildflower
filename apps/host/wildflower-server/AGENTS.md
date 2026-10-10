# AGENTS.md — apps/host/wildflower-server

The **Wildflower server** and the Rust crates of the server features only the
host composes. [`wildflower-server-rust`](./wildflower-server-rust/AGENTS.md)
is the server itself; the other crates here are the server halves of features
whose TypeScript halves live with the launcher, in `apps/launcher/`, or stay
in a slice because more than one product uses them (`slices/gatekeeper`,
`slices/fhir`).

## Packages

- [`wildflower-server-rust`](./wildflower-server-rust/AGENTS.md) — the server:
  `set_up` composes every server slice into one API and binds it, and
  `WildflowerServer::serve` serves it.
- **`gatekeeper-rust`** — the OAuth 2.0 / SMART authorization server: clients,
  grants, tokens, the bearer gate every other surface sits behind, and the
  `/access` admin routes. Its TypeScript half,
  [`slices/gatekeeper`](../../../slices/gatekeeper/AGENTS.md), is shared by
  every app that signs in.
- **`token-revocation-rust`** — the per-token denylist and per-subject epoch
  both enforcement points read: `gatekeeper-rust`'s gate and
  `fhir-r4-rust`'s `JtiCache`. Neither of those depends on the other.
- **`fhir-r4-rust`** — the embedded HFS FHIR R4 server mounted at `/fhir-r4`;
  its deltas from stock HFS are in its
  [Capability Statement](./fhir-r4-rust/docs/Capability%20Statement.md). The
  schemas and client every app reads it through are
  [`slices/fhir`](../../../slices/fhir/AGENTS.md).
- [`apps-rust`](./apps-rust/AGENTS.md) — the app registry and launch routes
  (`/apps`, `/home-screen`). Its TypeScript half is `apps-core-js` and
  `apps-react` in `apps/launcher/`.
- **`tunnel-rust`** — the embedded `rathole` client that dials the relay and
  hands each visitor's stream to the server's tunnel listener. The settings it
  shares with the relay, `rathole-settings-rust`, stay in `slices/rathole-settings-rust`.
- **`collector-rust`** — the collector remotes store (diesel) behind the
  `/collector` surface. Its TypeScript half is
  [`apps/launcher/collector`](../../launcher/collector/AGENTS.md).
- **`databases-rust`** — export, delete and list the host's SQLite databases
  (`/databases`), scope-gated per database. Its TypeScript half is
  `apps/launcher/databases`.
- **`request-log-rust`** — each forwarded request the server served, kept in
  `wildflower.sqlite` and served at `/requests`. Its TypeScript half is
  `apps/launcher/request-log`.
- **`har-recorder-rust`** — the HAR Recorder's bridge-wire mirror and the
  validated, atomic `save_har`. No `tauri` dependency.
- **`har-recorder-tauri`** — the HAR Recorder's host glue, attached from
  `host-app`'s `setup()`, not from the server. Its TypeScript half, and the
  recorder's design, are in
  [`apps/launcher/har-recorder`](../../launcher/har-recorder/AGENTS.md).

## Rules

- **Only the host uses these.** A crate lives here because the host is its
  only Rust consumer. The crates other crates or apps also use
  (`scopes-rust`, `persistence-rust`, `rathole-settings-rust`,
  `ohif-server-rust`, …) stay in `slices/`.
- **No slice depends on a crate here.** A test that drives two slices
  together belongs in `wildflower-server-rust`'s tests, which already compose
  both (`tests/scope_claims.rs`), never as a slice's dev-dependency on a crate
  in this folder.
- **The TypeScript half reads across folders.** Each OpenAPI snapshot is
  committed beside its crate (`<crate>/openapi/`) and read by relative path:
  `collector-registry`'s, `databases-core-js`'s, `request-log-core-js`'s and
  `apps-core-js`'s drift tests in `apps/launcher/`, `gatekeeper-core`'s drift
  test and schema codegen in `slices/gatekeeper`, and `apps/server-docs-web`.
  The FHIR R4 snapshot is the exception: HFS emits no spec, so `fhir-r4`
  generates it from its `HttpApi` and commits it in
  `slices/fhir/fhir-r4/openapi/`. Regenerate a
  stale one with
  `UPDATE_OPENAPI=1 cargo test -p <crate> openapi_spec_snapshot_is_up_to_date`
  and run `vp test openapi-drift`; see the
  [OpenAPI Spec Drift How-To](../../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).
- **Slice layering still applies.** The crates here are still layered as
  slices are (`domain` / `db` / `http`, scope-gated capabilities, no `tauri`
  dependency except in `har-recorder-tauri`).

## References

- [apps/host/AGENTS.md](../AGENTS.md) — the host and the other packages it is
  built from.
- [apps/AGENTS.md](../../AGENTS.md) — what folds into a product folder.
- [slices/AGENTS.md](../../../slices/AGENTS.md) — slice layering rules.
