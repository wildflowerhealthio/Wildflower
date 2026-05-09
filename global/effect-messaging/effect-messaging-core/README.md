# effect-messaging-core

Platform-agnostic core of the cross-process bridge transport. Provides
the `Bridge.make` factory for declaring typed bridges, the
`BridgeTransport.make` Effect for wiring multiple bridges through a
single dispatch fiber, and the `PlatformAdapter` Tag the platform
packages (`effect-messaging-react`, `effect-messaging-expo`) supply.

## Concepts

A **bridge** binds an outbound schema record to an inbound schema
record at the type level. `Bridge.make({hostToWeb, webToHost, …})`
returns two `Half`s — one per side — each with a typed `send` and a
`ReceiverLayer` factory.

A **transport** consumes a tuple of bridges plus their receiver
layers, drains the platform's initial messages, and forks a dispatch
fiber that decodes inbound messages to the right bridge's handler.
The transport's public `sendMessage` is the function-intersection of
every wired bridge's typed sender.

## Variance: `AnyHalf` and `AnyBridge`

The transport is generic over `Bridges extends ReadonlyArray<AnyBridge>`
so callers can pass any number of concrete bridges in any order.
Concrete halves have to fit through `AnyHalf`'s structural bound:

```ts
type AnyHalf = {
  readonly InboundSchemas: Message.SchemaRecord
  readonly OutboundSchemas: Message.SchemaRecord
  readonly HandlerTag: Context.Tag<any, any>
  readonly send: (m: never) => Effect.Effect<void, never, PlatformAdapter>
}
```

Two design points are load-bearing:

- **`Context.Tag<any, any>`** — `Context.Tag` is invariant in both
  parameters, so `Context.Tag<MyId, MyHandlers>` is _not_ assignable
  to `Context.Tag<string, unknown>`. `any` widens both invariant
  positions; concrete tags pass through.
- **`(m: never) => …`** — function parameters are contravariant.
  Every concrete `send: (m: SomeUnion) => …` is assignable to
  `(m: never) => …`. This also lets bridges with empty outbound
  records (`send: (m: never) => …` natively) fit without special-casing.

The runtime dispatch layer assumes the structural invariant: every
message has a `_tag: string` and the `senderByTag` map routes on that
tag. The `as TaggedSender` cast in `senderByTag` is the runtime
escape hatch — TS can't see through the `(m: never)` widening, but
runtime dispatch by `_tag` lands every message on a sender that
accepts it.

## Drain-then-replay

The Web platform adapter's `drainInitial` reads
`window.__INITIAL_MESSAGES__` once, deletes the global, and returns
the strings. The transport then offers each string into its dispatch
queue.

Web consumers that need to _peek_ at the initial messages before
mounting (e.g. to seed `<MemoryRouter initialEntries={[…]}>` at the
right path) can construct the adapter, drain it, and provide a replay
adapter that hands the same strings back through `drainInitial` to
`BridgeTransport.make`. See `effect-messaging-react/README.md` for the
full pattern.

## Subpaths

- `effect-messaging-core` — main barrel: `Bridge`, `BridgeTransport`,
  `Message`, `MessageHandler`, `DispatchError`, `PlatformAdapter`,
  `TestPlatformAdapterLayer`.
