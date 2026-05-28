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

Every value is an array indexed by bridge position. `bridges[i]`'s receiver layer is `receiverLayers[i]`; its zero-or-many initial messages are `initialMessages[i]`; its optional post-mount step is `onTransportReady[i]`. The whole struct is exactly the shape `BridgeTransport.make` consumes (after a single `flattenTuples(...)` to inline the `initialMessages` arrays), so no positional reshuffle happens at the call site.

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

Owns the WebView ref, builds the bridge transport inline (no separate `makeExpoTransport` indirection), and renders a `TransportWebView` once the transport state is set. The post-build step lives in a `useMemo` (keyed on `(bindings, transport)`) handed to `useComponentScopedRunner`, which runs `HostBindings.callTransportReady(bindings, transport.sendMessage)` on a component-scoped fiber so every per-bridge `onTransportReady` fires concurrently with fault isolation and the fiber is interrupted on unmount.

`initialMessages` is read once at transport build time and seeded into the WebView's URL as `?<Tag>=<value>` query params — the page reads them synchronously from `window.location.search` at boot.

## Why `BareSender` Lives in Dispatch

`AppsBridge.Host.send({ _tag: 'TunnelStarted', origin })` is an Effect requiring `BareSender`. Before earlier refactors, the apps receiver layer captured `BareSender` at layer-build time and re-provided it inside each handler — which forced the shell to fabricate a `Layer.succeed(BareSender, …)` that read the WebView ref lazily.

`BridgeTransport.make`'s dispatch fiber now wraps each handler invocation with the transport's adapter as `BareSender`. Handlers can call `bridge.send(...)` directly; the requirement is always satisfied by the same transport that delivered the inbound message.

The wider `HandlersFor<R>` type (`Effect<void, never, BareSender>`) is upward-compatible: handlers that don't need a reply return `Effect<void>` and still typecheck via covariance.

## Where the Casts Live

The parallel-tuple invariant carries through `combine`, `single`, and `callTransportReady` without any `as unknown as` casts. `flattenTuples` (in [`global/kitchen-sink/src/types/flatten-tuples.ts`](../../../kitchen-sink/src/types/flatten-tuples.ts)) handles the four mapped-tuple flat-concats inside `combine` directly — TS reduces the recursive `readonly [...Head, ...flattenTuples<Rest>]` shape against the parallel-array consumer without a re-narrowing step. `single` builds its 1-tuples with literal `[x] as const` shapes that TS unifies against `Bridge.TransportLayers<readonly [B], 'Host'>` structurally. `callTransportReady` distributes `MessageSender`'s outbound union over `Bridges[number]`, so the full-tuple sender is assignable into each narrow per-slot callback.

The page-side flatten in `bridged-webview.tsx` reuses the same `flattenTuples` helper to collapse `initialMessages` into a single sequence before `appendMessagesToUrl`. The consumer (`BridgedWebView` for the prop, `AppShellWebView` further up) sees a clean Bindings-shaped API with no casts in the chain.

## See Also

- [Effect Patterns Reference](../../../../docs/Effect/Patterns%20Reference.md) — Layer composition, generator syntax
- [HttpApi Composition How-To](../../../../docs/Effect/HttpApi%20Composition%20How-To.md) — A related cross-package phantom-id cast pattern
- `global/effect-messaging/effect-messaging-core/src/host-bindings.ts` — The `HostBindings` namespace
- `global/effect-messaging/effect-messaging-expo/src/bridged-webview.tsx` — The shell component
- `slices/*-expo/src/use-host-binding.ts` — Per-slice host-binding hooks
