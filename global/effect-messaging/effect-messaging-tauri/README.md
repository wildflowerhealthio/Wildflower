# effect-messaging-tauri

Tauri adapter for effect-messaging: a web-side bridge transport that
rides Tauri's event bus directly — every bridge message travels on the
single multiplexed `BRIDGE_EVENT` channel as a structured payload, with
the message's `_tag` field acting as the dispatch discriminator. No
string envelope and no postMessage machinery.

## Main exports

- `makeTauriTransport({ bridges, initial?, api? })` — builds the
  `{ sendMessage, coordinator }` seam a React app consumes. Attaches a
  single `BRIDGE_EVENT` listener, demuxes inbound (`HostToWeb`) tags
  through a pre-built dispatch table, validates payloads against the
  bridge schemas (`Schema.typeSchema`), then emits a `__Ready`-tagged
  payload on the bridge channel so the host can push its boot state
  (the host re-receives `__Ready` on every page load). The
  `coordinator` implements `effect-messaging-react`'s
  `HandlerCoordinator`, so slice `makeUseSliceRegister` hooks work
  unchanged.
- `BRIDGE_EVENT` / `READY_TAG` — the multiplexed channel name and
  reserved readiness tag, shared with Rust hosts. Pinned by
  `event-names.test.ts`; a Rust host should pin the same literals.

## Host contract

The Rust side listens on `BRIDGE_EVENT`, demuxes by the JSON payload's
`_tag` field (every bridge message already carries one by construction;
e.g. `{"_tag":"ResponseFinished","requestId":"…"}`), and emits its own
messages the same way. Tauri events are not buffered: the host must
only send in response to a `__Ready`-tagged payload (or later), which
this transport guarantees arrives after all listeners are attached.

## Why one channel and not per-tag

Tauri only guarantees FIFO _within_ a single event name. With a tag
per channel, a streaming sender's `ResponseFinished` could land at the
receiver before the in-flight `ResponseData` chunks because each
cross-tag delivery is its own `webview.eval(__TAURI_INTERNALS__.runCallback(…))`
injection on the receiver and Tauri makes no inter-injection ordering
promise. One channel = strict FIFO across every tag the protocol
uses, which the sniffer's chunked page-content stream relies on.

## Tag uniqueness across processes — manual discipline

`makeTauriTransport` runs `assertUniqueTags` over the bridges it is
handed, which catches collisions *within* a single transport instance.
The `BRIDGE_EVENT` channel is shared with every other listener in the
app (the main TS transport, the raw sniffer webview's bootstrap, every
Rust `app.listen(BRIDGE_EVENT, …)` host crate). A new tag that
duplicates a sibling listener's tag will **not** trip the assertion —
both listeners will receive every emit and dispatch independently.
There is deliberately no automated cross-process guard; the live
listener sets are scattered across TS bridges, raw sniffer code, and
two Rust crates, and the kind of registry that would let a test enumerate
them all would mostly be load-bearing for a test no one would read.

Whenever you add a tag on the bridge channel, manually confirm the
literal is unused across:

- Every `slices/*/<name>-core/src/bridge.ts` bridge schema.
- The raw sniffer's web-side bootstrap.
- Every Rust `match tag.as_str()` arm under `apps/wildflower-tauri/src-tauri/src/` and `slices/*/<name>-tauri-rust/src/`.

Each Rust listener also logs its complete tag set at attach time
(`info!("[<crate>] listening on bridge for tags: [...]")`) — grep the
boot log to cross-check what the live processes are dispatching on.
