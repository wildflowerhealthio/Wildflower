# effect-messaging-react

React bindings for `effect-messaging-core`. The transport itself comes
from a platform package (`effect-messaging-tauri`'s `makeTauriTransport`);
this package lets React slices reach its `HandlerCoordinator` and
register their inbound handlers from their own lifecycle.

## Main exports

- **`HandlerCoordinatorContext`** — React context carrying the
  transport's `HandlerCoordinator`. The app root provides it once the
  transport resolves.
- **`useHandlerCoordinator()`** — reads the surrounding coordinator;
  throws `NoContextException` without a provider.
- **`makeUseSliceRegister(bridge)`** — builds a slice's typed
  `register` / `unregister` hook with its own bridge pre-applied, so the
  handler record is checked against `bridge['HostToWeb']`. Instantiate
  it at module scope and export the resulting hook:

  ```ts
  const useCollectorRegister = makeUseSliceRegister(CollectorBridge)
  // …in a component:
  const { register, unregister } = useCollectorRegister()
  Effect.runFork(register(handlers))
  ```

- **`useLateBoundSender(senderRef)`** — an identity-stable sender that
  reads `senderRef.current` at send time, for a sender that is wired up
  after the consumer mounts.
- **`BridgeHandlerRecord` / `HandlerCoordinator`** — re-exported from
  `effect-messaging-core`, where the platform-agnostic contract lives.
