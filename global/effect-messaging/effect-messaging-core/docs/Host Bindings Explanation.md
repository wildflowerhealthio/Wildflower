# Host Bindings Explanation

How an Expo (or web, eventually) shell composes typed message bridges from multiple slices into a single WebView transport.

## The Problem

The wildflower-expo shell embeds an SPA in a `react-native-webview`. Four slices (`navigation`, `gatekeeper`, `collector`, `apps`) each declare a typed `Bridge` for cross-process messages. The shell has to:

1. Wire every bridge's host-side inbound handler record into one `BridgeTransport`.
2. Plumb URL-param initial messages (e.g. seed the SPA's first route).
3. Run post-mount side effects from inside the React provider (e.g. dispatch a bearer token).
4. Surface a typed send context to React subtree consumers (native tab bar, modals).

`BridgeTransport.makeHostTransport` takes parallel tuples — one `bridges` tuple, one same-length `handlers` tuple (plain inbound-handler records, no `Layer`). The shell's job is to assemble those parallel arrays — plus the URL-param initial messages and the post-mount callbacks — from independent slices without losing the index-aligned invariant on the way.

## The One Abstraction

### `HostBindings<Bridges>` — four parallel arrays

```typescript
interface HostBindings<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
  readonly initialMessages: {
    readonly [I in keyof Bridges]: ReadonlyArray<UrlParamableMessage<readonly [Bridges[I]]>>
  }
  readonly onTransportReady: {
    readonly [I in keyof Bridges]:
      | ((send: MessageSender<readonly [Bridges[I]], 'HostToWeb'>) => Effect.Effect<void>)
      | undefined
  }
}
```

Every value is an array indexed by bridge position. `bridges[i]`'s inbound handler record is `handlers[i]` (a plain `MessageHandler.HandlersFor<bridges[i]['WebToHost']>` — one Effect-returning function per inbound tag); its zero-or-many initial messages are `initialMessages[i]`; its optional post-mount step is `onTransportReady[i]`. `bridges` and `handlers` feed `BridgeTransport.makeHostTransport` directly; `initialMessages` is flattened (`flattenTuples`) and baked into the WebView URL; `onTransportReady` drives `callTransportReady`. No positional reshuffle happens at the call site.

Each slice's `*-expo` package exposes a `use<Slice>HostBinding` hook that returns a single-bridge `HostBindings<readonly [SliceBridge]>` (a 1-tuple). Single-bridge slices construct theirs via `HostBindings.single({...})`, which keeps the per-slice DX in the `{ bridge, handlers, initialMessages?, onTransportReady? }` shape:

```typescript
HostBindings.single({
  // Gatekeeper is host→web only, so its Host-side inbound record is empty.
  bridge: GatekeeperBridge,
  handlers: {},
  onTransportReady:
    token === undefined ? undefined : (send) => send({ _tag: 'AuthTokenIssued', token }),
})
```

Slice-specific policy lives next to the slice:

- `useGatekeeperHostBinding({ token })` routes `AuthTokenIssued` through `onTransportReady` — never URL params, since the bearer would leak into native WebView logs.
- `useNavigationHostBinding({ initialRoute, onRouteChanged })` seeds the URL-param channel itself.
- `useAppsHostBinding({ store })` discharges `TunnelStore` against the caller's store handle (the slice derives the layer internally via `TunnelStore.layerFrom(store)`).
- `useCollectorHostBinding()` wraps `useCollectorHostHandlers` (which reads the host handler record from `<CollectorHostProvider>`) into the uniform shape, and installs the transport's outbound sender into the collector pipe on `onTransportReady`.

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
  shouldOpenInSystemBrowser={maybePredicate}
/>
```

Owns the WebView ref and builds the bridge transport inline (no separate `makeExpoTransport` indirection). The `TransportWebView` mounts on the **first render** — under the host's native splash — so the page starts downloading immediately while the transport builds on a mount-bound fiber in parallel. There is no in-WebView JS loader gate; the built transport is stashed in a ref (nothing in render depends on it), so the page never waits on it. A `useMemo`-built build effect (keyed on `bindings.bridges`) is handed to `useComponentScopedRunner`, which runs `BridgeTransport.makeHostTransport` and then `HostBindings.callTransportReady(bindings, transport.sendMessage)` on a component-scoped fiber — every per-bridge `onTransportReady` fires concurrently with fault isolation, and closing the scope on unmount tears down both transport queues and both fibers.

A `bindings.handlers` reference flip (typically a sibling binding re-rendering — token arrival, modal state) is reconciled by routing the new records through `transport.registerHandlers` in a `useEffect`; the transport, its queues, and the `peerReadyGate` handshake all persist. Only a `bindings.bridges` reference change tears down and rebuilds the transport. There is no JS loader gate: the WebView is in the tree from the start and the app shell lets the native splash cover the load, hiding it on the page's UI-ready signal.

`initialMessages` is read once at first render and seeded into the WebView's URL as `?<Tag>=<value>` query params — the page reads them synchronously from `window.location.search` at boot.

## How a Handler Sends a Reply

Handlers are pure: `MessageHandler.HandlersFor<B['WebToHost']>` is one `(message) => Effect<void>` per inbound tag, with no `TransportAdapter` (or `BareSender`) in the requirement channel. The transport owns sending; a handler that only consumes an inbound message never touches the send path.

The one handler that _replies_ — apps' `RequestTunnel`, which answers with `TunnelStarted` / `TunnelFailed` — reaches the transport's sender through `onTransportReady`. The apps binding writes the transport's typed host sender into a **binding-scoped** `useRef` when `onTransportReady` fires (not a module-level global), and the `RequestTunnel` handler closes over that ref to issue its reply. When the ref is still `null` (transport not yet ready) the handler falls back to `HandlerHelpers.warnAboutDroppedTag`, so the message is acknowledged-and-dropped. This keeps the handler a plain `(message) => Effect<void>` while still letting it talk back, with no `Layer.succeed(BareSender, …)` fabrication at the shell and no module-level mutable state.

## Where the Casts Live

The parallel-tuple invariant carries through `combine`, `single`, and `callTransportReady` without any `as unknown as` casts. `flattenTuples` (in [`global/kitchen-sink/src/types/flatten-tuples.ts`](../../../kitchen-sink/src/types/flatten-tuples.ts)) handles the four mapped-tuple flat-concats inside `combine` directly — TS reduces the recursive `readonly [...Head, ...flattenTuples<Rest>]` shape against the parallel-array consumer without a re-narrowing step. `single` builds its 1-tuples with literal `[x] as const` shapes that TS unifies against `Bridge.HandlersByBridge<readonly [B], 'WebToHost'>` structurally. `callTransportReady` distributes `MessageSender`'s outbound union over `Bridges[number]`, so the full-tuple sender is assignable into each narrow per-slot callback.

The page-side flatten in `bridged-webview.tsx` reuses the same `flattenTuples` helper to collapse `initialMessages` into a single sequence before `appendMessagesToUrl`. The consumer (`BridgedWebView` for the prop, `AppShellWebView` further up) sees a clean Bindings-shaped API with no casts in the chain.

## See Also

- [Effect Patterns Reference](../../../../docs/Effect/Patterns%20Reference.md) — Layer composition, generator syntax
- [HttpApi Composition How-To](../../../../docs/Effect/HttpApi%20Composition%20How-To.md) — A related cross-package phantom-id cast pattern
- `global/effect-messaging/effect-messaging-core/src/host-bindings.ts` — The `HostBindings` namespace
- `global/effect-messaging/effect-messaging-expo/src/bridged-webview.tsx` — The shell component
- `slices/*-expo/src/use-host-binding.ts` — Per-slice host-binding hooks
