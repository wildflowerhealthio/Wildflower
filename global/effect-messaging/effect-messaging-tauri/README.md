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
e.g. `{"_tag":"AuthTokenIssued","token":"…"}`), and emits its own
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
