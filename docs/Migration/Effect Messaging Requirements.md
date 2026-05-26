# Effect Messaging Requirements

Open items the apps-expo migration surfaced. Each row names a thing the migration guide / Host-Bindings doc claim works that **doesn't actually typecheck on main**, and proposes the minimal fix.

## 1. Handlers can't call `bridge.send(...)` directly (claim vs. type system)

### Claim

- `effect-messaging-core/docs/Host Bindings Explanation.md` says:
  > `BridgeTransport.make`'s dispatch fiber now wraps each handler invocation with the transport's adapter as `BareSender`. **Handlers can call `bridge.send(...)` directly**; the requirement is always satisfied by the same transport that delivered the inbound message.
  > The wider `HandlersFor<R>` type (`Effect<void, never, BareSender>`) is upward-compatible: handlers that don't need a reply return `Effect<void>` and still typecheck via covariance.
- The migration guide echoes: "`BareSender` is no longer a layer-build requirement — the bridge transport's dispatch fiber provides it per-handler-invocation."

### Reality

- `global/effect-messaging/effect-messaging-core/src/message-handler.ts`:
  ```ts
  type HandlersFor<R> = { readonly [Tag in keyof R]: ... => Effect.Effect<void> }
  ```
- `bridge-transport.ts`'s `Handler` type is also `Effect.Effect<void>` (no env).
- So a handler that returns `AppsBridge.Host.send({...})` (which is `Effect<void, never, TransportAdapter>`) **does not typecheck** — `TransportAdapter` is not assignable away.

### Why the claim is half-right

At runtime the surrounding `handleDecode` is in a `TransportAdapter | Scope.Scope` context, so an `Effect<void, never, TransportAdapter>` handler **would** run successfully — the adapter is in scope. The implementation matches the doc; only the type narrows the handler signature too tightly to express it.

### Minimal fix (proposal)

Widen `HandlersFor`:

```ts
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void, never, TransportAdapter>
    : never
}
```

…and `Handler` in `bridge-transport.ts` to match. Existing handlers that return `Effect<void, never, never>` stay valid via Effect's covariance in the requirements parameter.

### Verification plan

- All current consumer `*-expo` slices (`navigation`, `gatekeeper`, `collector`, `browser-sniffer`, `apps`) compile unchanged.
- Once widened, `apps-expo` can swap back to direct `AppsBridge.Host.send(...)` — saving the `senderRef`/`useRef` ownership dance (see workaround below). Browser-sniffer would still want the ref for _external_ host→web sends from its `forwardRef` surface, but its internal handler path could go direct.

### Scope

Library-only (`effect-messaging-core`). Two file edits + a regression pass; no slice migrations move.

## 2. Workaround in use today

| Slice                  | Reply path                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps-expo`            | `useAppsHostBinding` owns `useRef<AppsHostMessageSender \| null>`; `onTransportReady` writes the ref; `ReceiverLayer(senderRef)` reads it inside the handler. Pre-mount sends drop loud via `Effect.logError`. |
| `browser-sniffer-expo` | Same shape, exposed externally via `forwardRef` (`BrowserSnifferWebView` lines 137–176).                                                                                                                       |
| `collector-expo`       | Doesn't reply from inside its own handlers — re-emits via `makeMessageSenderPipe`. Not affected.                                                                                                               |
| `navigation-expo`      | Receives only. Not affected.                                                                                                                                                                                   |
| `gatekeeper-expo`      | Receives only; `AuthTokenIssued` ships via `onTransportReady`, not from a handler. Not affected.                                                                                                               |

If the library fix lands, `apps-expo` would shrink: `host-receiver-layer.ts` drops the ref parameter and the `sendOrDrop` helper; `use-host-binding.ts` drops the `useRef` + `onTransportReady` plumbing. Tests would re-mock `AppsBridge.Host.send` (the 70479f shape).

## 3. Branch-only `makeUseHostMessaging` import

Already documented in the main migration guide ("These symbols don't exist on main and never will"). `apps-expo` chose **skip + document** rather than port via `makeMessageSenderPipe` because the only file using it (`apps-react/src/use-apps-host-messaging.ts`) had **zero consumers on `70479f8`** — it was scaffolding for a pattern the apps slice never actually exercised. The pipe pattern is the right replacement _if_ a future consumer needs host-tree mid-dispatch into `AppsBridge`; today none does.
