# Effect Messaging Requirements

Open items the apps-expo migration surfaced. Each row names a thing the migration guide / Host-Bindings doc claim works that **doesn't actually typecheck on main**, and proposes the minimal fix.

## 1. Handlers can't call `bridge.send(...)` directly — RESOLVED

`HandlersFor` (and `Handler` in `bridge-transport.ts`) were widened to return `Effect.Effect<void, never, TransportAdapter>`. The dispatch fiber's surrounding `handleDecode` already runs under the transport's own adapter, so the requirement is discharged per-invocation at runtime — the widening just lets the type system express what the implementation already does. Handlers that don't reply still typecheck: `Effect<void, never, never>` is assignable to the wider type via R-covariance.

**Caveat surfaced during the fix:** the widening forces every test site that calls handlers in isolation (`Effect.runPromise(handler.X(...))`) to provide a `TransportAdapter` layer — ~79 sites across 11 test files (most concentrated in `collector-fundamentals/src/handler/collector-bridge-message-handler.test.ts`). The standard discharge is `TestPlatformAdapterLayer.make().layer`; each affected test file now hoists one and pipes it through. Production code compiled unchanged.

`apps-expo` no longer needs the `senderRef` / `useRef` workaround — `host-receiver-layer.ts` calls `AppsBridge.Host.send(...)` directly and `use-host-binding.ts` drops the `onTransportReady` plumbing.

`browser-sniffer-expo` still owns a `MessageSender` ref because its `forwardRef` surface exposes one externally to consumers — that's a separate concern from the handler reply path.

## 2. Branch-only `makeUseHostMessaging` import

Already documented in the main migration guide ("These symbols don't exist on main and never will"). `apps-expo` chose **skip + document** rather than port via `makeMessageSenderPipe` because the only file using it (`apps-react/src/use-apps-host-messaging.ts`) had **zero consumers on `70479f8`** — it was scaffolding for a pattern the apps slice never actually exercised. The pipe pattern is the right replacement _if_ a future consumer needs host-tree mid-dispatch into `AppsBridge`; today none does.
