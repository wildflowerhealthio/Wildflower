# effect-messaging-react

Browser-side adapter for `effect-messaging-core`. Provides a
`WebPlatformAdapter` factory that wires the page side of the
WebView ↔ host postMessage bridge into Effect's `PlatformAdapter`
service.

## Why an adapter, not a wrapped transport

The page often needs to *peek* at the host-injected initial
messages before mounting (e.g. to seed a `<MemoryRouter
initialEntries={[...]}>` at the right path). Doing that with a
single fused `WebTransport.make({...})` wrapper requires reaching
inside the transport. Instead, the page constructs the adapter
itself, drains the initial messages once, and provides a replay
adapter to `BridgeTransport.make` so the dispatch fiber sees the
same messages exactly once.

```ts
import { Effect, Layer, ManagedRuntime } from 'effect'
import { BridgeTransport, PlatformAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'

const webAdapter = WebPlatformAdapter.make()
const initialMessages = Effect.runSync(webAdapter.drainInitial)

// Use `initialMessages` to derive routing, auth state, etc., then
// hand them back through a replay adapter so the dispatch fiber
// processes them once.
const replayAdapter = {
  bareSender: webAdapter.bareSender,
  drainInitial: Effect.succeed(initialMessages),
  attachLive: webAdapter.attachLive,
}

const transport = await managedRuntime.runPromise(
  Scope.extend(
    BridgeTransport.make({ bridges, layers, side: 'Web' })
      .pipe(Effect.provide(Layer.succeed(PlatformAdapter, replayAdapter))),
    scope
  )
)
```

## Behaviors

The adapter exposes the three `PlatformAdapter` surfaces:

- **`bareSender`** — calls
  `window.ReactNativeWebView.postMessage(encoded)`. Warns and
  drops when the host is absent (standalone-web bundles).
- **`drainInitial`** — reads
  `window[INITIAL_MESSAGES_WINDOW_GLOBAL]` (default
  `__INITIAL_MESSAGES__`), deletes the global so a hot reload
  doesn't double-replay, and filters out non-string entries.
- **`attachLive`** — `window.addEventListener('message', ...)`
  inside `Effect.acquireRelease`. The listener detaches when the
  transport's scope closes. The filter accepts events whose
  `source === window` and whose `origin` matches the page origin
  or is `''` (sandboxed / `file://` / `data:` documents).

## Threat model: postMessage origin trust

The `attachLive` filter admits `event.origin === ''` alongside the
same-origin check. Null origin appears for sandboxed iframes,
`data:` documents, and `file://` documents (the Expo host case).
Combined with `event.source === window`, this means the sender
must be the same window object — but the bundle still relies on
the host being trusted.

The bundle is loaded by Expo from a controlled scheme; it must
never be loaded inside an attacker-controlled frame. Hosts that
load this bundle in untrusted environments need to tighten
`attachLive` to `event.origin === window.location.origin` only.

See issue #24 for the full embedding-contract threat model.

## Wire-format constants

`INITIAL_MESSAGES_WINDOW_GLOBAL` and
`REACT_NATIVE_WEBVIEW_GLOBAL` live in `effect-messaging-core`'s
`platform-adapter.ts`. The Expo adapter
(`effect-messaging-expo`) imports the same constants so the
two-side contract is one source of truth.
