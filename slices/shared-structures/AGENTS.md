# AGENTS.md — slices/shared-structures

Cross-slice utilities: the phantom-id HttpApi composition helper every slice uses, the shared OpenAPI-drift machinery, and the process-daemon (watch / diff / execute) plumbing. Changes here ripple across every slice — check consumers before changing a contract.

## Guardrails

- **The phantom-id `*ApiHandlersFor<ParentId>()` helper lives here** (`shared-structures-core/src/http-api-implementation/`). Its `as unknown as Layer.Layer<...>` cast is the one sanctioned cast in the repo — read the [HttpApi Composition How-To](../../docs/Effect/HttpApi%20Composition%20How-To.md) before touching it or imitating it.
- **The shared OpenAPI snapshot machinery lives here** (`openapi_snapshot.rs` on the Rust side, the `openapi-drift` test on the TS side). Slices consume it; drift-guard behavior changes belong here, not in per-slice copies.

## Traps

- The process-daemon watch/diff/execute pattern is shared by multiple slice cores (e.g. tunnel) — a change to its semantics affects all of them. See the [Web Handler Coordinator Explanation](../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md) for the coordinator seam.
- This slice has the most adapters of any (`-core`, `-react`, `-rust`, `-server-rust`, `-tauri-rust`) — keep the layering rule in mind: adapters import `-core`, never the reverse.

## References

- [HttpApi Composition How-To](../../docs/Effect/HttpApi%20Composition%20How-To.md) — phantom-id bridge, `topLevel` collision
- [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md) — the drift guard this slice implements
- [Web Handler Coordinator Explanation](../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md) — coordinator seam
