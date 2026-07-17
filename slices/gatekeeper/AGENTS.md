# AGENTS.md — slices/gatekeeper

OAuth 2.0 / SMART-on-FHIR authorization slice. Read the [Jargon Explanation](./docs/Jargon%20Explanation.md) before touching auth flows — the domain vocabulary is precise and reviewers hold names to it.

## Guardrails

- **Tokens never ride the bridge.** `AuthTokenIssued` is a contentless notify; the bearer is pulled out-of-band via a capability-gated Tauri command. Keep it that way for anything secret.
- **Page paths are duplicated TS ⇄ Rust by design**: `gatekeeper-core/src/page-paths.ts` ⇄ `gatekeeper-rust/src/domain/page_paths.rs`, drift-tested by `gatekeeper-react/src/routes.test.tsx`. Changing a route means changing all three together — the drift test fails otherwise.
- **Bridge wire shapes are byte-pinned.** `gatekeeper-rust/src/bridge.rs` carries golden `*_serializes_to_pinned_wire_format` tests against the TS schemas in `gatekeeper-core/src/bridge.ts`. Follow the [Wire Pinning How-To](../../docs/Messaging/Wire%20Pinning%20How-To.md) when adding or changing a message.

## Traps

- The bootstrap-URL / `?token=` minting path is **dev-only** (NODE_ENV-gated) — not a shipping pattern to extend.
- There are two `AuthTokenStore` factories with different storage policies — see the [Auth Token Storage Explanation](./docs/Auth%20Token%20Storage%20Explanation.md) before picking one.
- The slice has a committed OpenAPI snapshot; regenerate a stale one per the [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

## References

- [Scope-Gated Endpoints How-To](../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md) — the `/access` surface's scope-gated `Scoped<F>`/capability pattern (machinery shared from `scopes/scope-capabilities-rust`); `http/capabilities/` is the worked fixed-scope example
- [gatekeeper-core README](./gatekeeper-core/README.md) — tables, OAuth routes, page-path drift test
- [Jargon Explanation](./docs/Jargon%20Explanation.md) — the domain vocabulary
- [Auth Token Storage Explanation](./docs/Auth%20Token%20Storage%20Explanation.md) — token storage policies
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the webview ↔ host bridge this slice speaks over
