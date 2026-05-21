# Host Bindings Explanation

How an Expo (or web, eventually) shell composes typed message bridges from multiple slices into a single WebView transport.

## The Problem

The wildflower-expo shell embeds an SPA in a `react-native-webview`. Four slices (`navigation`, `gatekeeper`, `collector`, `apps`) each declare a typed `Bridge` for cross-process messages. The shell has to:

1. Wire every bridge's host-side receiver layer into one `BridgeTransport`.
2. Plumb URL-param initial messages (e.g. seed the SPA's first route).
3. Run post-mount side effects from inside the React provider (e.g. dispatch a bearer token).
4. Surface a typed send context to React subtree consumers (native tab bar, modals).

Before this refactor, the shell did all four jobs inline: a positional pair of bridge tuples and layer tuples, a `BareSender` ref-resolution dance so the apps slice could reply to `RequestTunnel`, a shim component that existed only to call `useGatekeeperHostMessaging` inside the provider, and a 162-line component knitting it together.

## The Two Abstractions

### `HostBinding<B>` — one slice's host wiring

```typescript
interface HostBinding<B extends Bridge.AnyBridge> {
  readonly bridge: B
  readonly receiverLayer: Layer.Layer<HostHandlerTagId<B>>
  readonly initialMessages?: ReadonlyArray<UrlParamableMessage<readonly [B]>>
  readonly onTransportReady?: (send: BindingSend) => Effect.Effect<void>
}
```

Each slice's `*-expo` package exposes a `use<Slice>HostBinding` hook that returns one of these. The bridge and its receiver layer are paired by construction; the shell can't accidentally hand a Foo-shaped layer to a Bar slot.

Slice-specific policy lives next to the slice:

- `useGatekeeperHostBinding({ token })` routes `AuthTokenIssued` through `onTransportReady` — never URL params, since the bearer would leak into native WebView logs.
- `useNavigationHostBinding({ initialRoute, onRouteChanged })` seeds the URL-param channel itself.
- `useAppsHostBinding({ tunnelStoreLayer })` discharges `TunnelStore` against a caller-supplied store layer so the slice never sees the bare livestore.
- `useCollectorHostBinding()` wraps the existing `useReceiverLayer` (which reads from `<HostProvider>`) into the uniform shape.

### `BridgedWebView` — the generic shell

Takes an ordered tuple of `HostBinding`s plus inline HTML + a base URL. Owns the WebView ref, mounts the transport via `WithTransport`, provides `HostMessagingProvider`, and renders the WebView followed by a named `belowWebView` slot (typically a native tab bar) inside the provider.

The shell handles aggregation via `HostBinding.aggregate(bindings)`, which produces the parallel tuples `BridgeTransport.make` requires. After the transport is built, a `TransportReadyCaller` child runs each binding's `onTransportReady` effect with a widened sender.

## Why `BareSender` Lives in Dispatch

`AppsBridge.Host.send({ _tag: 'TunnelStarted', origin })` is an Effect requiring `BareSender`. Before this refactor, the apps receiver layer captured `BareSender` at layer-build time and re-provided it inside each handler — which forced the shell to fabricate a `Layer.succeed(BareSender, …)` that read the WebView ref lazily.

`BridgeTransport.make`'s dispatch fiber now wraps each handler invocation with the transport's adapter as `BareSender`. Handlers can call `bridge.send(...)` directly; the requirement is always satisfied by the same transport that delivered the inbound message.

The wider `HandlersFor<R>` type (`Effect<void, never, BareSender>`) is upward-compatible: handlers that don't need a reply return `Effect<void>` and still typecheck via covariance.

## Why `BindingSend` Is Widened

`Bridge.MessageSender<Bridges, 'Host'>` is `UnionToIntersection<...>` — a function-intersection across every wired bridge's typed sender. This shape is contravariant in `Bridges`, which means a tuple of narrowly-typed `HostBinding<X_i>` doesn't structurally unify with `ReadonlyArray<HostBinding.Any>`: the contravariant position blocks the assignment.

`BindingSend` is the single-signature widened form the React `HostMessagingContext` already uses: `(message: { _tag: string; [key: string]: unknown }) => Effect<void>`. Slices construct narrowly-typed message literals inline; runtime dispatch by `_tag` lands every message correctly.

## Where the Casts Live

Two `as unknown as` casts remain, both inside `HostBinding.aggregate`:

1. `bindings.map(b => b.bridge) as unknown as BridgesOf<Bs>` — Array.prototype.map widens tuple positions to `T[]`; the runtime mapping is provably parallel.
2. `bindings.map(b => b.receiverLayer) as unknown as LayersOf<Bs>` — same.

Plus one cast in `TransportReadyCaller`: `transport.sendMessage as unknown as BindingSend` — covered by the function-intersection-to-widened-signature gap above.

All three live in one file (`host-binding.ts`) where the parallel-tuple invariant and the sender-shape correspondence are local. The consumer (`BridgedWebView`) sees a clean Bindings-shaped API with no casts.

## See Also

- [Effect Patterns Reference](./Patterns%20Reference.md) — Layer composition, generator syntax
- [HttpApi Composition How-To](./HttpApi%20Composition%20How-To.md) — A related cross-package phantom-id cast pattern
- `global/effect-messaging/effect-messaging-core/src/host-binding.ts` — The `HostBinding` namespace
- `global/effect-messaging/effect-messaging-expo/src/bridged-webview.tsx` — The shell component
- `slices/*-expo/src/use-host-binding.ts` — Per-slice host-binding hooks
