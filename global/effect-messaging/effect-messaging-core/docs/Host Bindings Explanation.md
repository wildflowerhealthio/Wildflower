# Host Bindings Explanation

How an Expo (or web, eventually) shell composes typed message bridges from multiple slices into a single WebView transport.

## The Problem

The wildflower-expo shell embeds an SPA in a `react-native-webview`. Four slices (`navigation`, `gatekeeper`, `collector`, `apps`) each declare a typed `Bridge` for cross-process messages. The shell has to:

1. Wire every bridge's host-side receiver layer into one `BridgeTransport`.
2. Plumb URL-param initial messages (e.g. seed the SPA's first route).
3. Run post-mount side effects from inside the React provider (e.g. dispatch a bearer token).
4. Surface a typed send context to React subtree consumers (native tab bar, modals).

`BridgeTransport.make` takes parallel tuples — one `bridges` tuple, one same-length `layers` tuple — and a flat list of initial messages. The shell's job is to assemble those four parallel arrays from independent slices without losing the index-aligned invariant on the way.

## The One Abstraction

### `HostBindings<Bridges>` — four parallel arrays

```typescript
interface HostBindings<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly receiverLayers: Bridge.TransportLayers<Bridges, 'Host'>
  readonly initialMessages: {
    readonly [I in keyof Bridges]: ReadonlyArray<UrlParamableMessage<readonly [Bridges[I]]>>
  }
  readonly onTransportReady: {
    readonly [I in keyof Bridges]:
      | ((send: MessageSender<readonly [Bridges[I]], 'Host'>) => Effect.Effect<void>)
      | undefined
  }
}
```

Every value is an array indexed by bridge position. `bridges[i]`'s receiver layer is `receiverLayers[i]`; its zero-or-many initial messages are `initialMessages[i]`; its optional post-mount step is `onTransportReady[i]`. The whole struct is exactly the shape `BridgeTransport.make` consumes (after a single `.flat()` to inline the `initialMessages` arrays), so no positional reshuffle happens at the call site.

Each slice's `*-expo` package exposes a `use<Slice>HostBinding` hook that returns a single-bridge `HostBindings<readonly [SliceBridge]>` (a 1-tuple). Single-bridge slices construct theirs via `HostBindings.single({...})`, which keeps the per-slice DX in the traditional `{ bridge, receiverLayer, initialMessages?, onTransportReady? }` shape:

```typescript
HostBindings.single({
  bridge: GatekeeperBridge,
  receiverLayer: GatekeeperBridge.Host.ReceiverLayer({}),
  initialMessages: [{ _tag: 'WaitForToken' }],
  onTransportReady:
    token === undefined ? undefined : (send) => send({ _tag: 'AuthTokenIssued', token }),
})
```

Slice-specific policy lives next to the slice:

- `useGatekeeperHostBinding({ token })` routes `AuthTokenIssued` through `onTransportReady` — never URL params, since the bearer would leak into native WebView logs.
- `useNavigationHostBinding({ initialRoute, onRouteChanged })` seeds the URL-param channel itself.
- `useAppsHostBinding({ tunnelStoreLayer })` discharges `TunnelStore` against a caller-supplied store layer so the slice never sees the bare livestore.
- `useCollectorHostBinding()` wraps the existing `useReceiverLayer` (which reads from `<HostProvider>`) into the uniform shape.

### `HostBindings.combine([...])` — tuple flat-concat

```typescript
const bindings = HostBindings.combine([
  navigationBindings,
  gatekeeperBindings,
  collectorBindings,
  appsBindings,
  logBindings,
])
```

Each of the four arrays is concatenated in tuple order. The result satisfies `HostBindings<readonly [...Nav, ...Gk, ...Coll, ...Apps, ...Log]>` — the parallel-tuple invariant survives. There's no separate `aggregate` step: the shape callers build is already the shape the transport consumes.

`combine` takes a single tuple parameter (not rest `...bindings`) because `babel-preset-expo` transpiles rest params to `new Array(_len)`, which would crash at runtime — `bridge.ts` and `bridge-transport.ts` import Effect's `Array` module at the top of the bundled `dist/index.js` and shadow the global constructor.

### `BridgedWebView` — the generic shell

```tsx
<BridgedWebView
  bindings={bindings}
  loadFrom={{ _tag: 'html', html, baseUrl }}
  loader={<Loader />}
  shouldOpenInSystemBrowser={maybePredicate}
/>
```

Owns the WebView ref, builds the bridge transport inline (no separate `makeExpoTransport` indirection), and renders a `TransportWebView` once the transport state is set. A second `useEffect`, keyed on `(bindings, transport)`, runs `HostBindings.callTransportReady(bindings, transport.sendMessage)` so every per-bridge `onTransportReady` fires concurrently with fault isolation.

`initialMessages` is read once at transport build time and seeded into the WebView's URL as `?<Tag>=<value>` query params — the page reads them synchronously from `window.location.search` at boot.

## Why `BareSender` Lives in Dispatch

`AppsBridge.Host.send({ _tag: 'TunnelStarted', origin })` is an Effect requiring `BareSender`. Before earlier refactors, the apps receiver layer captured `BareSender` at layer-build time and re-provided it inside each handler — which forced the shell to fabricate a `Layer.succeed(BareSender, …)` that read the WebView ref lazily.

`BridgeTransport.make`'s dispatch fiber now wraps each handler invocation with the transport's adapter as `BareSender`. Handlers can call `bridge.send(...)` directly; the requirement is always satisfied by the same transport that delivered the inbound message.

The wider `HandlersFor<R>` type (`Effect<void, never, BareSender>`) is upward-compatible: handlers that don't need a reply return `Effect<void>` and still typecheck via covariance.

## Why `callTransportReady` Casts the Sender

`MessageSender<Bridges, 'Host'>` is declared `out Bridges` (covariant on the bridges tuple). A per-slot `onTransportReady[i]` is typed `(send: MessageSender<readonly [Bridges[i]], 'Host'>) => Effect<void>` — the narrow sender for that one bridge.

`callTransportReady` only has the full-tuple sender. Passing it to a narrow slot would naturally compose via function-parameter contravariance — except the `out` annotation declares the type covariant, which blocks the assignment. One `as unknown as` cast bridges the gap. At runtime the per-slot callback only fires `bridges[i]`-shaped messages, which the full-tuple sender accepts.

## Where the Casts Live

Three `as unknown as` casts remain, all inside `HostBindings.combine`. Each one re-narrows an `Array.prototype.flatMap` result to the tuple-mapped shape the consumer expects:

1. `bindings.flatMap(b => b.bridges)` → `FlatBridges<T>`
2. `bindings.flatMap(b => b.receiverLayers)` → `Bridge.TransportLayers<FlatBridges<T>, 'Host'>`
3. `bindings.flatMap(b => b.initialMessages)` → `InitialMessagesByBridge<FlatBridges<T>>` (preserves the array-of-arrays shape; the shell `.flat()`s before passing to `appendMessagesToUrl`)
4. `bindings.flatMap(b => b.onTransportReady)` → `OnTransportReadyByBridge<FlatBridges<T>>`

Plus the one cast in `callTransportReady`: `send as unknown as MessageSender<…>` — the covariance-annotation gap above.

All five live in two files — `host-bindings.ts` for the parallel-tuple invariant, and nothing in `bridged-webview.tsx` (the inlined transport build has no casts). The consumer (`BridgedWebView` for the prop, `AppShellWebView` further up) sees a clean Bindings-shaped API.

## See Also

- [Effect Patterns Reference](../../../../docs/Effect/Patterns%20Reference.md) — Layer composition, generator syntax
- [HttpApi Composition How-To](../../../../docs/Effect/HttpApi%20Composition%20How-To.md) — A related cross-package phantom-id cast pattern
- `global/effect-messaging/effect-messaging-core/src/host-bindings.ts` — The `HostBindings` namespace
- `global/effect-messaging/effect-messaging-expo/src/bridged-webview.tsx` — The shell component
- `slices/*-expo/src/use-host-binding.ts` — Per-slice host-binding hooks
