# Web Handler Coordinator Explanation

The page-side `BridgeTransport` is built **once at boot**, outside React (see `apps/wildflower-react/src/bridges/build-transport.ts`). But each slice's real inbound handlers only exist once its React subtree mounts (a sync starts, a tunnel request fires). This document explains how the web bridges that lifecycle gap with a **handler coordinator** instead of per-slice module-level forwarder cells.

## The mechanism

`makeHandlerCoordinator` (in `effect-messaging-react`) holds one inbound handler record per bridge **name**. On every change it recomposes the full per-bridge tuple in `bridges` order and calls the transport's `registerHandlers` **once** — `registerHandlers` has replace-the-whole-tuple semantics, so recomposing centrally is what lets independent slices register without clobbering each other.

Because the transport needs a complete initial tuple but the coordinator needs the transport's `registerHandlers`, the factory is two-phase:

```ts
const { initialHandlers, connect } = makeHandlerCoordinator({
  bridges,
  inboundDirection: 'HostToWeb',
  initial,
})
// build the transport with `initialHandlers`, then:
const coordinator = connect(transport.registerHandlers)
```

A React context (`HandlerCoordinatorContext`, provided in `AppRootTree`) surfaces the coordinator; slices read it with `useHandlerCoordinator()` and `Effect.runFork` its `register` / `unregister` Effects from their own lifecycle:

- **collector** (`useSyncRunner`) registers its per-sync handler in the `Collector` slot when a sync starts and unregisters on unmount.
- **apps** (`useRequestTunnel`) registers a per-request, resolver-bound handler in the `Apps` slot and unregisters when the request settles.

## Drop-all default

`registerHandlers` requires a **complete** record per bridge. A bridge with nothing registered gets a generated **drop-all** record — every inbound tag maps to `HandlerHelpers.warnAboutDroppedTag` — so a message that arrives before (or after) a slice is mounted is log-and-dropped rather than crashing. This is the same observable behavior the old forwarder cells had on their `null` branch, now generated once by the coordinator.

## Set-if-equal and supersede

- **Set-if-equal unregister.** `unregister(name, record)` only relinquishes the slot if it still holds that exact `record`. A successor mount (StrictMode double-mount, rapid remount) may already have taken the slot; unregistering unconditionally would drop the fresher handler. The set-if-equal check makes stale cleanups no-ops.
- **Supersede (apps only).** `useRequestTunnel` tracks the in-flight request's `settle` in a module-level cell; a newer request settles the predecessor with a `superseded by newer request` error before registering its own handler, so the prior Promise never dangles and a stale host response can't resolve the new request.

## The gatekeeper exception

Gatekeeper does **not** register on mount. `makeGatekeeperWebHandlers` is a boot-stable handler that writes the auth token into a `SubscriptionRef` (`authTokenRef`); React **subscribes** to that ref rather than being a mounted handler. The token arrives over the bridge _before_ the `_auth` gate renders, so it's seeded into the coordinator's `initial` records at boot. (`authTokenRef` is observable state the handler writes — not a swappable handler cell, so it stays.)

## Why a central coordinator, not a per-bridge merge API

`registerHandlers` replaces the whole tuple. The coordinator owns _all_ slices' records and recomposes the whole tuple on every change — that's what makes independent slice registration safe without adding a per-bridge `registerHandlersFor` merge API (which would carry its own ordering/race questions). The bridges-tuple order is the single source of truth for tuple positions.

## Page lifetime and boot ordering

The page-side `BridgeTransport` is intentionally never torn down. `apps/wildflower-react/src/bridges/build-transport.ts` creates a `pageLifetimeScope` via `Effect.runSync(Scope.make())` and never closes it — the transport, its dispatch fiber, and the console interceptor live as long as the page does. Tests that need teardown call `BridgeTransport.makeWebTransport` directly with their own scope (see `web-transport.integration.test.ts`).

The console interceptor is installed **immediately after the transport is built and before `signalReady` is awaited**, so any `console.*` emitted by Sentry init (`instrument.ts`), the transport's own internals, or the adapter's `drainInitial` rides the outbox-then-flush path. Installing later would silently drop those early lines.

`navigate` is the only seam onto the router, captured behind a stable indirection (a router-instance ref the caller wires up) so the transport build can run before `createRouter` returns.

## See also

- [Effect Patterns Reference](./Patterns%20Reference.md)
- `global/effect-messaging/effect-messaging-react/src/handler-coordinator.ts` — `makeHandlerCoordinator`, `useHandlerCoordinator`
- `slices/gatekeeper/gatekeeper-react/src/client/auth-state-store.ts` — `authTokenRef` (the boot-stable `SubscriptionRef` exception)
