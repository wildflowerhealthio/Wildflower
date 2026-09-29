# Web Handler Coordinator Explanation

The page-side bridge transport is built **once at boot**, outside React: the Tauri entry (`apps/wildflower-tauri/src/main.tsx`) calls `makeTauriTransport` from its `makeTransport` factory, and the standalone web entry uses `stubTransport`. But each slice's real inbound handlers only exist once its React subtree mounts (a sync starts, a recording begins). This document explains how the web bridges that lifecycle gap with a **handler coordinator** instead of per-slice module-level forwarder cells.

## The mechanism

The transport exposes a `HandlerCoordinator` (the contract lives in `effect-messaging-core`) that holds one inbound handler record per bridge **name**. `makeTauriTransport` implements it over a name-keyed map that its dispatch reads **at dispatch time**, so a `register` or `unregister` takes effect on the next inbound message without re-listening.

A React context (`HandlerCoordinatorContext`, provided in `AppRootTree`) surfaces the coordinator. Each slice binds a typed accessor for its own bridge with `makeUseSliceRegister(bridge)` and `Effect.runFork`s its `register` / `unregister` Effects from its own lifecycle:

- **collector** (`useSyncRunner`) registers its per-sync handler in the `Collector` slot when a sync starts and unregisters on unmount.
- **har-recorder** (`useHarRecorder`) registers its records in the `Collector` and `HarRecorder` slots while a recording runs.

## Drop-all default

A bridge with nothing registered has no record, and every inbound tag for it is logged and dropped through `HandlerHelpers.warnAboutDroppedTag`. A message that arrives before (or after) a slice is mounted is therefore dropped rather than crashing.

## Set-if-equal unregister

`unregister(bridge, record)` only relinquishes the slot if it still holds that exact `record`. A successor mount (StrictMode double-mount, rapid remount) may already have taken the slot; unregistering unconditionally would drop the fresher handler. The set-if-equal check makes stale cleanups no-ops, which is why a slice builds its record once and reuses that same object.

## The gatekeeper exception

Gatekeeper does **not** register on mount. `makeGatekeeperWebHandlers` is a boot-stable record, seeded through `makeTauriTransport`'s `initial` option, that writes into the entry's `AuthStateStore` and the in-app `ActivePendingConsentStore`. The host pushes `AuthTokenIssued` in response to the page's `__Ready`, _before_ the `_auth` gate renders, so the handler has to be in place from the start. React **subscribes** to those stores rather than being a mounted handler.

## Page lifetime and boot ordering

The page-side transport is intentionally never torn down: its `BRIDGE_EVENT` listener stays attached for the page's lifetime, and page teardown drops it with the document.

`makeTauriTransport` emits `__Ready` only once its listener has attached, so the host's first push cannot race listener setup. The Tauri entry installs the console interceptor after the transport resolves; `console.*` output from before that point stays local.

## See also

- [Effect Patterns Reference](./Patterns%20Reference.md)
- [Bridge Explanation](../Messaging/Bridge%20Explanation.md)
- `global/effect-messaging/effect-messaging-tauri/src/tauri-transport.ts` — `makeTauriTransport` and its coordinator
- `global/effect-messaging/effect-messaging-react/src/handler-coordinator.ts` — `HandlerCoordinatorContext`, `useHandlerCoordinator`, `makeUseSliceRegister`
