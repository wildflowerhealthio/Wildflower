# Effect Messaging Requirements

Open requirements surfaced by the `slices/collector` migration from `70479f8`.

## R1 — Per-slice host-side outbound `MessageSender` access — RESOLVED

### Need

A mid-tree host component (e.g. `CollectorModalScreen` rendered under
`expo-router` inside the same shell as the host's `BridgedWebView`) must call
the WebView-side bridge as if it were the host transport — i.e. send a
**`HostToWeb` message** through `CollectorBridge.hostToWeb`.

The collector slice also has a second cross-component dispatch need: the
collector's receiver-layer handlers (`Click`, `CancelSnifferRequest`) must
reach the `<BrowserSnifferWebView>` mounted inside the modal screen.

### How it's resolved

`makeMessageSenderPipe(name, bridges, side)` in
`global/effect-messaging/effect-messaging-react/src/make-message-sender-pipe.tsx`
is the right primitive. PR #81 reshaped `BrowserSnifferWebView` to expose a
typed `BridgeTransport.MessageSender` via its `ref` (and `BridgedWebView` will
do the same for the collector SPA host), so a pipe is fed by simply
`useAsPipeMessageSender(webViewRef.current)` at the mount site.

This PR adds **two per-slice pipes** in
`slices/collector/collector-expo/src/message-sender-pipes.tsx`:

| Pipe                | Bridges                  | Side     | Reads                                                                                                                    | Writes                                                                                       |
| ------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| BrowserSniffer pipe | `[BrowserSnifferBridge]` | `'Host'` | `useMessageSenderToBrowserSniffer()` — used by `useReceiverLayer`'s `Click` / `CancelSnifferRequest` handlers            | `useAsMessageSenderToBrowserSniffer(snifferRef)` — used by the modal screen                  |
| Collector pipe      | `[CollectorBridge]`      | `'Host'` | `useMessageSenderToCollector()` — used by the modal screen to re-emit sniffer events through `CollectorBridge.hostToWeb` | `useAsMessageSenderToCollector(collectorRef)` — used by the app shell's `BridgedWebView` ref |

`HostProvider` mounts both pipe `Provider`s so consumers see a single
`<CollectorBridgeExpo.HostProvider>` mount point.

### One required upstream tweak

`usePipeMessageSender` previously read `handlerRef.current` eagerly at render
time, which meant a receiver-layer closure capturing the pipe sender at
build time would freeze the no-op default forever (even after the modal mounts
and registers the real sender). PR #?? changes `usePipeMessageSender` to
return a stable suspend-wrapped function that reads `.current` lazily, so
late-registered senders are picked up on the next send without re-render.
Same pattern `BrowserSnifferWebView` already uses internally for its own
`stableSender`. Tests in `make-message-sender-pipe.test.tsx` simplify
correspondingly (no more `rerender()` flushes between register and send).

### Files unblocked

The blocked-from-the-original-port files still aren't ported in this PR —
the unblocking infrastructure lands here; the screen/route work follows in
a separate PR:

| File                                                                        | Status                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `slices/collector/collector-react/src/use-collector-host-messaging.ts`      | **Obsolete** — `useMessageSenderToCollector` from `'collector-expo'` is the replacement. |
| `slices/collector/collector-expo/src/screens/CollectorModalScreen.tsx`      | **Unblocked** — port follow-up.                                                          |
| `slices/collector/collector-expo/src/screens/CollectorModalScreen.test.tsx` | **Unblocked** — port follow-up.                                                          |
| `slices/collector/collector-expo/src/screens/CollectorModalRoute.tsx`       | **Unblocked** — port follow-up.                                                          |
