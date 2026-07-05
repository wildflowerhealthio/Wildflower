# Bridge Explanation

Why the webview ↔ host bridge exists, how its pieces layer, and where the traps are. The bridge is a monorepo-wide contract: `global/effect-messaging` owns the machinery, slices declare their own message schemas on top of it, and Rust hosts speak the same wire format from the other side of the process boundary.

## The problem it solves

Wildflower embeds web UIs inside native hosts (Tauri webviews). The page and the host need typed, ordered, bidirectional messaging across a boundary where neither side shares memory with the other. The bridge gives each slice a declarative way to say "these are the messages I send and receive" without owning transport, ordering, or handshake concerns.

## The layers

- [`effect-messaging-core`](../../global/effect-messaging/effect-messaging-core/README.md) — platform-agnostic machinery. `Bridge.make` declares a named pair of directional schema records (`HostToWeb` / `WebToHost`, one `[tag]: schema` entry per message). `BridgeTransport.makeHostTransport` / `makeWebTransport` wire any number of bridges through a single dispatch fiber, with an outbox/inbox queue pair and a one-way `__Ready` handshake. A bridge is only its schemas — sending, dispatch, and endpoint identity all live in the transport.
- [`effect-messaging-react`](../../global/effect-messaging/effect-messaging-react/README.md) — browser adapter: `postMessage` sender, `__INITIAL_MESSAGES__` drain, and the `attachLive` listener with its origin-trust filter.
- [`effect-messaging-tauri`](../../global/effect-messaging/effect-messaging-tauri/README.md) — Tauri adapter: every message rides the single multiplexed `BRIDGE_EVENT` channel as a structured payload, demuxed by `_tag`.
- **Slice bridge declarations** — each participating slice declares its messages in `<name>-core/src/bridge.ts` (e.g. `GatekeeperBridge`, `CollectorBridge`, `BrowserSnifferBridge`) as `Schema.parseJson(Schema.TaggedStruct(...))` entries.
- **Rust hosts** — mirror the wire shapes with `#[serde(tag = "_tag")]` enums and listen/emit on the same channel. See the [Wire Pinning How-To](./Wire%20Pinning%20How-To.md) for keeping the two sides byte-compatible.

## The mental model

Every message is a JSON object with a `_tag` discriminator. Ordering is FIFO because everything shares one channel — that is a deliberate trade-off, not an accident: Tauri only guarantees FIFO _within_ one event name, and streaming protocols (the sniffer's chunked page-content stream) depend on cross-tag ordering. Do not introduce per-tag channels.

The `__Ready` handshake is one-way: the host buffers its outbox until the web side signals ready; the web side sends freely from the start. Tauri events are not buffered by the platform, so a host that emits before `__Ready` arrives is sending into the void.

## Traps

- **Tag uniqueness across processes is manual discipline.** `assertUniqueTags` only catches collisions within one transport instance. The shared channel has many listeners (TS transports, the raw sniffer bootstrap, Rust host crates), and a duplicated tag double-dispatches silently. Before adding a tag, follow the checklist in the [effect-messaging-tauri README](../../global/effect-messaging/effect-messaging-tauri/README.md).
- **Secrets never ride the bridge.** The multiplexed channel is observable by sibling listeners. Gatekeeper's `AuthTokenIssued` is a contentless notify — the bearer is pulled out-of-band via a capability-gated command. Follow that pattern for anything sensitive.
- **Host listeners receive their own emits.** A Rust `app.listen(BRIDGE_EVENT, …)` handler also sees the host's own replies; it must dispatch on only its inbound tags and drop everything else.
- **postMessage origin trust is a real threat model** — the web adapter admits `origin === ''` for the native-host case; the bundle must never load in an attacker-controlled frame. See the [effect-messaging-react README](../../global/effect-messaging/effect-messaging-react/README.md).

## See also

- [Wire Pinning How-To](./Wire%20Pinning%20How-To.md) — steps for adding or changing a message that crosses the TS ⇄ Rust boundary
- [Review Standards Reference](../Agents/Review%20Standards%20Reference.md) — round-trip and one-source-of-truth rules the bridge surfaces are held to
