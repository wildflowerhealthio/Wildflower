# AGENTS.md — global/effect-messaging

The webview ↔ host bridge machinery. This is `global/` code: project-agnostic, no slice knowledge — bridges are _declared_ in slices (`<name>-core/src/bridge.ts`), never here. Read the [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) for how the pieces fit.

## Guardrails

- **Tag uniqueness across processes is manual discipline.** `assertUniqueTags` only guards a single transport instance; the multiplexed channel is shared with the raw sniffer bootstrap and every Rust host listener. Before adding a tag anywhere, run the checklist in the [effect-messaging-tauri README](./effect-messaging-tauri/README.md).
- **One channel, strict FIFO — don't split per-tag.** Tauri only guarantees ordering within a single event name; streaming consumers rely on cross-tag FIFO. The rationale is in the [effect-messaging-tauri README](./effect-messaging-tauri/README.md).

## Traps

- The variance machinery (`AnyBridge`, `AnyStringEncodedSchema`, `Message.Of`) is load-bearing and subtle — read the [effect-messaging-core README](./effect-messaging-core/README.md) §Variance before changing any of the generic types.
- The `attachLive` origin filter admits `origin === ''` deliberately (native-host case) — it is a documented threat-model trade-off, not a bug. See the [effect-messaging-react README](./effect-messaging-react/README.md) before tightening or loosening it.
- The `__Ready` handshake is one-way and the host buffers until it lands; Tauri events are unbuffered, so host emits before `__Ready` are lost by design.

## References

- [effect-messaging-core README](./effect-messaging-core/README.md) — bridge/transport concepts, two-queue model, variance
- [effect-messaging-react README](./effect-messaging-react/README.md) — web adapter, drain-then-replay, threat model
- [effect-messaging-tauri README](./effect-messaging-tauri/README.md) — multiplexed channel, tag-uniqueness checklist
- [Wire Pinning How-To](../../docs/Messaging/Wire%20Pinning%20How-To.md) — keeping TS ⇄ Rust wire shapes byte-compatible
