# effect-messaging-core

Platform-agnostic core of the cross-process bridge transport. Provides
the `Bridge.make` factory for declaring typed bridges, the
`BridgeTransport.make` Effect for wiring multiple bridges through a
single dispatch fiber, and the `TransportAdapter` Tag the platform
packages (`effect-messaging-react`, `effect-messaging-expo`) supply.

## Concepts

A **bridge** binds an outbound schema record to an inbound schema
record at the type level. `Bridge.make({hostToWeb, webToHost, …})`
returns two `Half`s — one per side — each with a typed `send`. The
inbound side of a half is served by a plain **handler record**
(`Bridge.HalfHandlers<Half>` = `MessageHandler.HandlersFor<InboundSchemas>`):
one Effect-returning function per inbound tag, passed as a value — no
`Context.Tag`, no `Layer`.

A **transport** consumes a tuple of bridges plus a parallel tuple of
their handler records (`Bridge.HandlersByBridge<Bridges, Side>`), drains
the platform's initial messages, and forks a dispatch fiber that
decodes inbound messages to the right bridge's handler. The transport's
public `sendMessage` is the function-intersection of every wired
bridge's typed sender. `registerHandlers(next)` swaps the active records
at runtime via an in-place `Ref.set` (see [Two queues](#two-queues)).

## Variance: `AnyHalf` and `AnyBridge`

The transport is generic over `Bridges extends ReadonlyArray<AnyBridge>`
so callers can pass any number of concrete bridges in any order.
Concrete halves have to fit through `AnyHalf`'s structural bound:

```ts
type AnyHalf = {
  readonly InboundSchemas: Message.SchemaRecord
  readonly OutboundSchemas: Message.SchemaRecord
  readonly send: (m: never) => Effect.Effect<void, never, TransportAdapter>
}
```

The load-bearing point is the `send` widening:

- **`(m: never) => …`** — function parameters are contravariant.
  Every concrete `send: (m: SomeUnion) => …` is assignable to
  `(m: never) => …`. This also lets bridges with empty outbound
  records (`send: (m: never) => …` natively) fit without special-casing.

There is no handler-tag field on the half anymore: inbound handlers are
plain records supplied alongside the bridges via
`HandlersByBridge<Bridges, Side>`, so the only variance the half has to
absorb is on `send`. `HalfHandlers<H>` reads `H['InboundSchemas']`
structurally, so concrete handler records fit `AnyHalf` without an
invariant tag position to widen.

The runtime dispatch layer assumes the structural invariant: every
message has a `_tag: string` and the `senderByTag` map routes on that
tag. The `as TaggedSender` cast in `senderByTag` is the runtime
escape hatch — TS can't see through the `(m: never)` widening, but
runtime dispatch by `_tag` lands every message on a sender that
accepts it.

## Two queues

Two unbounded `Queue`s run behind the public surface, each drained by
one scoped fiber:

- **outbox** — `sendMessage` offers here and returns immediately (it
  never suspends the caller). A pump fiber awaits the `peerReady`
  Deferred once, then drains forever, routing each message through the
  `senderByTag` map. Sends issued before the peer is ready buffer in
  order and flush the moment the handshake lands.
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
`BridgeTransport.make`. See `effect-messaging-react/README.md` for the
full pattern.

## Subpaths

- `effect-messaging-core` — main barrel: `Bridge`, `BridgeTransport`,
  `HostBindings`, `Message`, `MessageHandler`, `Logging`,
  `TransportAdapter`, `UrlParamMessage`, `TestPlatformAdapterLayer`,
  and the `bare-sender` re-exports.
