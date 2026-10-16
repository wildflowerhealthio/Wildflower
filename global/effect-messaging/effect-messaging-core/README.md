# effect-messaging-core

Platform-agnostic core of the cross-process bridge transport. Provides
the `Bridge.make` factory for declaring typed bridges, the
`BridgeTransport.makeHostTransport` Effect for wiring multiple bridges
through a single dispatch fiber, the `TransportAdapter` Tag a platform
adapter supplies, and `PageDispatcher.make`, the page-side dispatcher
(and `HandlerCoordinator` implementation) that page transports
(`effect-messaging-tauri-js`) wrap.

## Concepts

A **bridge** is a pair of directional schema records declared at the
type level. `Bridge.make({ hostToWeb, webToHost, … })` returns a value
carrying a `HostToWeb` and a `WebToHost` record (one `[tag]: schema`
entry per message): `HostToWeb` is what the host sends and the web
receives, `WebToHost` is the reverse. A bridge knows only its schemas —
it has no `send`, no notion of a transport, and no endpoint identity. The
`Bridge.Direction` (`'HostToWeb' | 'WebToHost'`) simply names the two
records; the endpoint→direction mapping lives only at the transport
entry points (`makeHostTransport` binds inbound `WebToHost` / outbound
`HostToWeb`; `makeTauriTransport` in `effect-messaging-tauri-js` is the
page-side mirror).

The inbound side is served by a plain **handler record**
(`MessageHandler.HandlersFor<Bridge[Direction]>`): one Effect-returning
function (`(message) => Effect<void>`) per inbound tag, passed as a value
— no `Context.Tag`, no `Layer`.

A **transport** consumes a tuple of bridges plus a parallel tuple of
their handler records (`Bridge.HandlersByBridge<Bridges, 'WebToHost'>`)
and forks a dispatch fiber that decodes inbound messages to the right
bridge's handler. The transport owns all sending: its public
`sendMessage` is typed as the union of every wired bridge's outbound
messages (`Bridge.SendableMessage<Bridges, 'HostToWeb'>`), and internally it encodes
each message with `Message.stringifyMessage` against the merged outbound
record before handing the wire string to the adapter's bare sender.
`registerHandlers(next)` swaps the active records at runtime via an
in-place `Ref.set` (see [Two queues](#two-queues)).

## Variance: `AnyBridge` and `AnyStringEncodedSchema`

The transport is generic over `Bridges extends ReadonlyArray<AnyBridge>`
so callers can pass any number of concrete bridges in any order. A
concrete bridge has to fit through `AnyBridge`'s structural bound:

```ts
type AnyBridge = {
  readonly name: string
  readonly HostToWeb: Message.SchemaRecord
  readonly WebToHost: Message.SchemaRecord
}
```

The load-bearing point is `Message.SchemaRecord`, whose values are
`AnyStringEncodedSchema = Schema.Schema<any, string, never>`. The `any`
widens `Schema`'s invariant decoded-type (`A`) parameter so records
carrying different message unions all satisfy the same bound. The
precise decoded type is recovered centrally by `Message.Of`: it maps
each schema to its decoded type, then rebinds the resulting union through
a constrained `infer M extends { readonly _tag: string }`. Over a
_generic_ record the mapped step collapses to `any` (the value bound is
`Schema<any, …>`), and the rebind floors it to `{ _tag: string }` — so
the dispatch pump's `message._tag` access stays concrete and non-`any`;
over a _concrete_ record the rebind is the identity and the real tagged
union survives. `SendableMessage` and `HandlersByBridge` delegate to
`Message.Of`, so they need no `infer` of their own;
`MessageHandler.HandlersFor` recovers each tag's payload with its own
mapped `infer A`. A bridge has no `send` function to widen anymore — it
is just its two schema records, so the only variance to absorb is on the
schema values themselves.

The runtime dispatch and send layers assume the structural invariant:
every message has a `_tag: string`. Inbound, the dispatch fiber decodes
through a single `parseJson(Union(...))` and routes on `_tag`. Outbound,
`Message.stringifyMessage(record, message)` looks up
`record[message._tag]` and encodes — no cast required, since the lookup
is keyed by the runtime tag the invariant guarantees.

## Two queues

Two unbounded `Queue`s run behind the public surface, each drained by
one scoped fiber:

- **outbox** — `sendMessage` offers here and returns immediately (it
  never suspends the caller). A pump fiber awaits the `peerReadyGate`
  Deferred once, then drains forever, encoding each message with
  `Message.stringifyMessage` against the merged outbound record and
  handing the resulting wire string to the adapter's bare sender. Sends
  issued before the peer is ready buffer in order and flush the moment
  the handshake lands.
- **inbox** — carries raw inbound wire strings. One dispatch fiber
  processes them FIFO. Each decodes through a single
  `parseJson(Union(...))`; a tag with no current handler is
  logged-and-dropped (even though schema acceptance proves it's a known
  inbound tag). `registerHandlers` swaps the active handler map in place
  via a `Ref.set` — no inbox round-trip — so the next message dispatches
  against the new records.

The `__Ready` handshake is one-way. The host buffers its outbox until it
dispatches the web peer's `__Ready` — routed through the normal inbound →
handler path, where an injected control handler resolves `peerReadyGate`.
The optional `onPageReady` callback runs on every `__Ready`, so a
reloaded page re-receives the host's boot-state push. Scope close shuts
both queues down and interrupts both fibers.

## Page dispatcher

`PageDispatcher.make({ bridges, initial? })` returns `{ offer, coordinator }`:
everything a page-side transport does except moving bytes. A transport
feeds each inbound payload — a structured value, not a wire string — to
`offer(payload)` and hands `coordinator` to the app; the dispatcher never
sees the channel itself.

- **Tag check.** `make` first runs `assertUniqueTags`: a page channel
  carries both directions, so every tag must be unique across bridges
  _and_ directions, and none may claim the reserved `__Ready` tag.
  Throws synchronously, before the transport attaches anything.
- **Demux.** `offer` reads the payload's `_tag` and looks it up in a
  dispatch table built once from every bridge's `HostToWeb` record.
  Payloads without a string `_tag`, or with a tag no bridge declares
  inbound, are dropped silently (a `WebToHost` echo of the page's own
  send, a sibling bridge's traffic).
- **Validate and route.** Each payload is decoded against its schema's
  struct side (`Schema.typeSchema`) and routed to the bridge's record
  active _at dispatch time_. An undecodable payload, a bridge with no
  registered record, and a handler defect are each logged and dropped;
  the next payload dispatches normally.
- **One FIFO inbox.** `offer` enqueues synchronously onto one unbounded
  queue drained by a single fiber, so payloads apply in `offer` order
  across every tag even while a handler suspends.
- **Coordinator.** `initial` seeds boot-stable records keyed by bridge
  name (`InitialHandlers<Bridges>`, typed per bridge). `register` is
  last-writer-wins and `unregister` is set-if-equal, per bridge name.

The dispatcher lives for the page's lifetime; nothing tears it down.

## Subpaths

- `effect-messaging-core` — main barrel: `Bridge`, `BridgeTransport`,
  `Message`, `MessageHandler`, `PageDispatcher`, `HandlerHelpers`,
  `TransportAdapter`, the `BridgeHandlerRecord` / `HandlerCoordinator`
  types, and the `bare-sender` re-exports.
- `effect-messaging-core/test` — `TestPlatformAdapterLayer`, the
  capturing-stub `Layer<TransportAdapter>` for tests. Kept out of the
  production barrel (mirrors the `vite-plus/test` convention).
