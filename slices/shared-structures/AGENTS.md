# AGENTS.md — slices/shared-structures

Cross-slice utilities: the phantom-id HttpApi composition helper every slice uses and the shared OpenAPI-drift machinery. Changes here ripple across every slice — check consumers before changing a contract.

## Guardrails

- **The phantom-id `*ApiHandlersFor<ParentId>()` helper lives here** (`shared-structures-core/src/http-api-implementation/`). Its `as unknown as Layer.Layer<...>` cast is the one sanctioned cast in the repo — read the [HttpApi Composition How-To](../../docs/Effect/HttpApi%20Composition%20How-To.md) before touching it or imitating it.
- **The shared OpenAPI snapshot machinery lives here** (`openapi_snapshot.rs` on the Rust side, the `openapi-drift` test on the TS side). Slices consume it; drift-guard behavior changes belong here, not in per-slice copies.

## Traps

- This slice has the most adapters of any (`-core`, `-react`, `-rust`, `-server-rust`, `-tauri-rust`) — keep the layering rule in mind: adapters import `-core`, never the reverse.

## References

- [Scope-Gated Endpoints How-To](../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md) — the reusable capability machinery (`Scoped<F>`, `Capability`, `ScopeClaims`) lives in `scopes/scope-capabilities-rust`, **not** here; this slice only supplies the `http-errors` `InternalError` the machinery reuses for its fail-closed 500
- [HttpApi Composition How-To](../../docs/Effect/HttpApi%20Composition%20How-To.md) — phantom-id bridge, `topLevel` collision
- [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md) — the drift guard this slice implements
- [Web Handler Coordinator Explanation](../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md) — coordinator seam
