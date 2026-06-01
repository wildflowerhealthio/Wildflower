# effect-messaging-core

Platform-agnostic core of the cross-process bridge transport. Provides
the `Bridge.make` factory for declaring typed bridges, the
`BridgeTransport.makeHostTransport` / `makeWebTransport` Effects for
wiring multiple bridges through a single dispatch fiber, and the
`TransportAdapter` Tag the platform packages (`effect-messaging-react`,
`effect-messaging-expo`) supply.

## Concepts

A **bridge** is a pair of directional schema records declared at the
type level. `Bridge.make({ hostToWeb, webToHost, … })` returns a value
carrying a `HostToWeb` and a `WebToHost` record (one `[tag]: schema`
entry per message): `HostToWeb` is what the host sends and the web
receives, `WebToHost` is the reverse. A bridge knows only its schemas —
it has no `send`, no notion of a transport, and no endpoint identity. The
`Bridge.Direction` (`'HostToWeb' | 'WebToHost'`) simply names the two
records; the endpoint→direction mapping lives only at the two transport
entry points (`makeHostTransport` binds inbound `WebToHost` / outbound
`HostToWeb`; `makeWebTransport` is the mirror).

The inbound side is served by a plain **handler record**
(`MessageHandler.HandlersFor<Bridge[Direction]>`): one Effect-returning
function (`(message) => Effect<void>`) per inbound tag, passed as a value
— no `Context.Tag`, no `Layer`.

A **transport** consumes a tuple of bridges plus a parallel tuple of
their handler records (`Bridge.HandlersByBridge<Bridges, InDir>`), drains
the platform's initial messages, and forks a dispatch fiber that
decodes inbound messages to the right bridge's handler. The transport
owns all sending: its public `sendMessage` is typed as the union of
every wired bridge's outbound messages for the outbound direction
(`Bridge.SendableMessage<Bridges, OutDir>`), and internally it encodes
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
  readonly UrlParamSchemas: Readonly<Record<string, Schema.Schema<any, string, never> | undefined>>
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
  never suspends the caller). A pump fiber awaits the `peerReady`
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

The `__Ready` handshake is one-way and rides the same inbox dispatch
path on both sides: the host's `peerReady` resolves when it dispatches
the web peer's `__Ready`; the web self-queues a `__Ready` at make so its
own gate resolves through the identical path (no parallel pre-resolve
branch). `signalReady` posts the `__Ready` wire string on the web and is
a no-op on the host. Scope close shuts both queues down and interrupts
both fibers.

## Drain-then-replay

The Web platform adapter's `drainInitial` reads
`window.__INITIAL_MESSAGES__` once, deletes the global, and returns
the strings. The transport then offers each string into the inbox —
behind the web's self-`__Ready`, so the handshake gates before the
seeded messages dispatch.

Web consumers that need to _peek_ at the initial messages before
mounting (e.g. to seed `<MemoryRouter initialEntries={[…]}>` at the
right path) can construct the adapter, drain it, and provide a replay
adapter that hands the same strings back through `drainInitial` to
`makeWebTransport`. See `effect-messaging-react/README.md` for the
full pattern.

## Subpaths

- `effect-messaging-core` — main barrel: `Bridge`, `BridgeTransport`,
  `HostBindings`, `Message`, `MessageHandler`, `Logging`,
  `TransportAdapter`, `UrlParamMessage`, `TestPlatformAdapterLayer`,
  and the `bare-sender` re-exports.
