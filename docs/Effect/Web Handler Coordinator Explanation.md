# Web Handler Coordinator Explanation

The page-side bridge transport is built **once at boot**, outside React: the host's entry (`apps/host/host-app/src/main.tsx`) calls `makeTauriTransport` over `RecorderBridge` for its Recorder tab. But each slice's real inbound handlers only exist once its React subtree mounts (a recording begins). This document explains how the web bridges that lifecycle gap with a **handler coordinator** instead of per-slice module-level forwarder cells.

## The mechanism

The transport exposes a `HandlerCoordinator` (the contract lives in `effect-messaging-core`) that holds one inbound handler record per bridge **name**. `effect-messaging-core`'s `PageDispatcher.make` implements it over a name-keyed map that its dispatch reads **at dispatch time**, and `makeTauriTransport` hands that coordinator out, so a `register` or `unregister` takes effect on the next inbound message without re-listening.

A React context (`HandlerCoordinatorContext`, provided in the host shell's Recorder tab) surfaces the coordinator. Each slice binds a typed accessor for its own bridge with `makeUseSliceRegister(bridge)` and `Effect.runFork`s its `register` / `unregister` Effects from its own lifecycle:

- **recorder** (`useRecorder`, in the host's Recorder tab) registers its record in the `Recorder` slot for as long as the Recorder page is mounted, so the host's answer to a save still reaches it after the sniffer window has closed.

## Drop-all default

A bridge with nothing registered has no record, and every inbound tag for it is logged and dropped through `HandlerHelpers.warnAboutDroppedTag`. A message that arrives before (or after) a slice is mounted is therefore dropped rather than crashing.

## Set-if-equal unregister

`unregister(bridge, record)` only relinquishes the slot if it still holds that exact `record`. A successor mount (StrictMode double-mount, rapid remount) may already have taken the slot; unregistering unconditionally would drop the fresher handler. The set-if-equal check makes stale cleanups no-ops, which is why a slice builds its record once and reuses that same object.

## Page lifetime and boot ordering

The page-side transport is intentionally never torn down: its `BRIDGE_EVENT` listener stays attached for the page's lifetime, and page teardown drops it with the document.

`makeTauriTransport` emits `__Ready` only once its listener has attached, so the host's first push cannot race listener setup.

## See also

- [Effect Patterns Reference](./Patterns%20Reference.md)
- [Bridge Explanation](../Messaging/Bridge%20Explanation.md)
- `global/effect-messaging/effect-messaging-core/src/page-dispatcher.ts` — `PageDispatcher.make` and its coordinator
- `global/effect-messaging/effect-messaging-tauri-js/src/tauri-transport.ts` — `makeTauriTransport`, the Tauri glue around it
- `global/effect-messaging/effect-messaging-react/src/handler-coordinator.ts` — `HandlerCoordinatorContext`, `useHandlerCoordinator`, `makeUseSliceRegister`
