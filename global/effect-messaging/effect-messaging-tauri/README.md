# effect-messaging-tauri

Tauri adapter for effect-messaging: a web-side bridge transport that
rides Tauri's event bus directly — each bridge message travels on its
own `bridge:{tag}` event as a structured payload, with no string
envelope and no postMessage machinery.

## Main exports

- `makeTauriTransport({ bridges, initial?, api? })` — builds the
  `{ sendMessage, coordinator }` seam a React app consumes. Attaches one
  Tauri listener per inbound (`HostToWeb`) tag, validates payloads
  against the bridge schemas (`Schema.typeSchema`), then emits
  `bridge:__Ready` so the host can push its boot state (the host
  re-receives `__Ready` on every page load). The `coordinator`
  implements `effect-messaging-react`'s `HandlerCoordinator`, so slice
  `makeUseSliceRegister` hooks work unchanged.
- `eventNameForTag` / `READY_EVENT` / `READY_TAG` — the `bridge:{tag}`
  event-name convention shared with Rust hosts. Pinned by
  `event-names.test.ts`; a Rust host should pin the same literals.

## Host contract

The Rust side listens for `bridge:__Ready` and emits its messages on
`bridge:{tag}` events whose payloads serialize to the bridge schemas'
struct form (e.g. `{"_tag":"AuthTokenIssued","token":"…"}`). Tauri
events are not buffered: the host must only send in response to
`__Ready` (or later), which this transport guarantees arrives after all
listeners are attached.
