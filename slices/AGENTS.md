# AGENTS.md — slices/

Vertical product slices. Each slice owns a feature end-to-end (HTTP API, store, UI adapters) and is layered into a pure core plus optional platform adapters.

## Slice Layout

Every slice is a `<name>-core` (usually) plus optional platform adapters. The suffix names the target:

```text
slices/<name>/
├── <name>-core            # Pure logic: schemas, HttpApi definitions, business rules (no DOM/fs/platform imports)
├── <name>-react           # Browser UI adapter — the dominant web adapter
├── <name>-rust            # Native/server Rust adapter
├── <name>-tauri           # Tauri host adapter (TS side)
├── <name>-tauri-rust      # Tauri host adapter (Rust side)
├── <name>-node            # Node.js adapter
└── <name>-web             # Browser (non-React) adapter — currently only telemetry
```

Slices may also carry slice-specific packages (e.g. `collector-fundamentals`, `fhir-r4-client-collector`, `fhir-r4` / `fhir-r4-react` under `emr`). A few slices are Rust-only with no `-core` (`persistence`); others are core-only with no adapters yet (`web-trace`).

Current slices: `apps`, `browser-sniffer`, `collector`, `databases`, `emr`, `gatekeeper`, `navigation`, `persistence`, `scopes`, `shared-structures`, `telemetry`, `tunnel`, `web-trace`. Verify with `ls slices/` — this list can go stale.

`web-trace` records a browsing session as FHIR `DocumentReference`s and exports a redacting HAR — see [web-trace/AGENTS.md](./web-trace/AGENTS.md). Its `web-trace-core` sits below both a collector and a React app, which is why it is a slice of its own rather than a package inside either. The collector that consumes it, [`web-trace-collector`](./collector/web-trace-collector/AGENTS.md), lives in the `collector` slice — a `*-client-collector` belongs where the descriptor seam is, not next to the codec it imports.

## Rules

- **`<name>-core` is the pure layer** — no DOM, no Node `fs`, no platform-specific imports
- **Platform adapters depend on `-core`, never the reverse**
- **Compose `HttpApi` groups across slices via the phantom-id bridge pattern** — see [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md)
- **Don't use `topLevel: true` on multiple `HttpApiGroup`s under the same `HttpApi`** — name collision in the generated client. See [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md).

## References

- [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md) — Phantom-id bridge, `*ApiHandlersFor<ParentId>()`, `topLevel` collision
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Tag/Layer wiring used inside slice cores
- [Bridge Explanation](../docs/Messaging/Bridge%20Explanation.md) — The webview ↔ host bridge slices declare messages on (`<name>-core/src/bridge.ts`); see the [Wire Pinning How-To](../docs/Messaging/Wire%20Pinning%20How-To.md) when a message crosses TS ⇄ Rust
- [Learnings Inbox](../docs/Agents/Learnings%20Inbox.md) — Slice-specific vp-pack gotchas not yet promoted
