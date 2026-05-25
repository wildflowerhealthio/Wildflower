# Effect Messaging Requirements

Open requirements surfaced by the `slices/collector` migration from `70479f8`.
Each gap blocks at least one branch-only file from porting onto main as-is.

## R1 — Per-slice host-side outbound `MessageSender` access

### Need

A mid-tree host component (e.g. `CollectorModalScreen` rendered under
`expo-router` inside the same shell as the host's `BridgedWebView`) must call
the WebView-side bridge as if it were the host transport — i.e. send a
**`HostToWeb` message** through `CollectorBridge.hostToWeb`.

On the branch this was solved with a `shared-structures-react` helper
`makeUseHostMessaging(Bridge)` → `useCollectorHostMessaging()` exposing
`{ send, sendEffect }`, fed by a single `<HostMessagingProvider>` mounted in
the host shell. **Neither helper nor provider exists on `main`.**

### What main has today

| Piece                                        | Where                                                     | Reach                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `makeMessageSenderPipe(name, bridges, side)` | `effect-messaging-react/src/make-message-sender-pipe.tsx` | Returns `Provider` + `useAsPipeMessageSender(sender)` + `usePipeMessageSender()`. Ref-backed slot.                      |
| `HostBinding.onTransportReady(send)`         | `effect-messaging-core/src/host-binding.ts`               | Fires once after `BridgedWebView` finishes building the transport. Receives the tuple-typed `send`.                     |
| `BridgedWebView`                             | `effect-messaging-expo/src/bridged-webview.tsx`           | Owns the transport in local state, exposes `bindings` + `BridgeDispatchRegistryProvider`, does NOT pipe `send` outward. |

`makeMessageSenderPipe` is the right primitive; nothing wires it to the
transport for a slice. `onTransportReady` returns an `Effect`, while
`useAsPipeMessageSender(sender)` is a hook — they can't be composed without a
state holder + a component sitting inside the slice's `Provider`.

### Where the friction lands

The cleanest per-slice wiring looks like:

```tsx
// 1. Build the pipe once per slice.
const { Provider, useAsPipeMessageSender, usePipeMessageSender } = makeMessageSenderPipe(
  'Collector',
  [CollectorBridge],
  'Host'
)

// 2. A consumer component (inside <Provider>) bridges onTransportReady → useAsPipeMessageSender.
const CollectorHostBinder = ({ children }) => {
  const [send, setSend] = useState<MessageSender | null>(null)
  const binding: HostBinding<typeof CollectorBridge> = useMemo(
    () => ({
      bridge: CollectorBridge,
      receiverLayer: useCollectorReceiverLayer(),
      onTransportReady: (s) => Effect.sync(() => setSend(() => s)),
    }),
    [
      /* deps */
    ]
  )
  useAsPipeMessageSender(send ?? noopSender)
  // ...but the host shell needs `binding`, not `children`. Where does it go?
}
```

The dependency cycle: `BridgedWebView` needs `bindings` (built inside
`CollectorHostBinder`), and `CollectorHostBinder` needs to be a child of
`<Provider>` _and_ a sibling of `BridgedWebView` _and_ able to hand
`bindings` to `BridgedWebView`. That third constraint is the blocker — you
can't both **render** the binding wrapper and **pass its built binding** up
to a parent.

Two solutions both require new infra:

1. **Generalise `BridgedWebView`**: take a `senderPipe?: MessageSenderPipe` per
   binding and auto-wire `onTransportReady` → `useAsPipeMessageSender` internally.
2. **Introduce `makeHostMessaging(name, bridge, side)`** returning a
   `{ Provider, useHostBinding, useHostMessaging }` triple where `Provider` mounts
   both the pipe and a ref the `useHostBinding`-produced binding writes into via
   `onTransportReady`. Mirrors the branch's `makeUseHostMessaging` but built on
   `makeMessageSenderPipe` instead of inventing a new ref.

Solution (2) matches the branch's mental model and keeps the call sites in
the slice. Solution (1) is more global but cleaner for shells that wire many
slices.

### Blocked files

| File                                                                                     | Branch source                                           | Status after this PR              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------- |
| `slices/collector/collector-react/src/use-collector-host-messaging.ts`                   | `70479f8`                                               | **Skipped** — needs R1            |
| `slices/collector/collector-expo/src/screens/CollectorModalScreen.tsx`                   | `70479f8` (uses `useCollectorHostMessaging()`)          | **Skipped** — needs R1            |
| `slices/collector/collector-expo/src/screens/CollectorModalScreen.test.tsx`              | `70479f8` (mocks the hook; would build, behaviour stub) | **Skipped** — pair with screen    |
| `slices/collector/collector-expo/src/screens/CollectorModalRoute.tsx`                    | `70479f8` (renders `CollectorModalScreen`)              | **Skipped** — pair with screen    |
| `slices/collector/collector-react/src/index.ts` re-export of `useCollectorHostMessaging` | `70479f8`                                               | **Reverted** — file doesn't exist |

The rest of the collector migration ports cleanly:

| File                                                                                                                            | Notes                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `collector-expo/src/host-receiver-layer.tsx` (HostProvider/useHost/useReceiverLayer/useHostBinding)                             | Self-contained — receiver only; no outbound traffic through the bridge.                         |
| `collector-expo/src/host-receiver-layer.test.ts`                                                                                | Type-only test against `MessageHandler.TagId<'Collector', 'Host'>`.                             |
| `collector-expo/src/host-provider.test.tsx` + `host-provider-control.test.tsx` + `__test-support__/host-provider-test-mocks.ts` | Mock both `collector-react` and the bridge — runs even with `useCollectorHostMessaging` absent. |
| `collector-expo/src/index.ts` (`CollectorBridgeExpo` namespace + `CollectorModalScreen`/`Route` exports)                        | Strip the `Screen`/`Route` exports until R1 resolves.                                           |
| `collector-fundamentals/src/handler/collector-bridge-message-handler.test.ts`                                                   | `BareSender` no-op layer added — unrelated to R1.                                               |
| `collector-react/tests/collector-runtime-provider.test.tsx`                                                                     | `BareSender` merge — unrelated to R1.                                                           |

## Suggested next step

Pick one of solutions (1) or (2) above, land it as a standalone PR against
`effect-messaging-react`/`effect-messaging-expo`, then re-port the four
blocked collector files on top.
