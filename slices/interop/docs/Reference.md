# Interop Reference

Quick-lookup facts for the cross-process Message bridge. For _what each
package does_, see [Packages Explanation](./Packages%20Explanation.md).

## Message vocabulary

A **Message** is one direction, fire-and-forget — sender and receiver are
loosely coupled, no request/response correlation. Encoded form on the wire
is a string; decoded form is a `_tag`-tagged record.

### Slice-neutral tags (interop-core)

| Tag                      | Direction    | Payload                                    | Purpose                                                                                                                                               |
| ------------------------ | ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeBackRequested`    | Native → Web | `{}`                                       | Header chevron tap or hardware-back gesture; web pops its router.                                                                                     |
| `AppNavigationRequested` | Native → Web | `{ path: string }`                         | Host asks the embedded SPA to navigate to `path`. Used both as the initial route (via `__INITIAL_MESSAGES__`) and for runtime host-driven navigation. |
| `RouteChanged`           | Web → Native | `{ pathname: string; canGoBack: boolean }` | Web reports each router transition. `canGoBack` drives the chevron.                                                                                   |

### Direction records

Each slice contributes two records: `<Slice>NativeToWeb` (messages flowing
into the web side) and `<Slice>WebToNative` (the reverse). Aggregators
spread them into combined records per direction:

```ts
const NativeToWeb = { ...InteropNativeToWeb, ...GatekeeperNativeToWeb }
const WebToNative = { ...InteropWebToNative, ...GatekeeperWebToNative }
```

The platform handler's type parameters are `(Receive, Send)`. The web side
gets `MessageHandler<NativeToWeb, WebToNative>`; the Expo side reverses
them. The type system enforces direction — `handler.sendMessage(...)` is
only callable with tags from the `Send` record.

## Naming conventions

- Past-tense events / noun-events. Messages are observed facts, not
  imperatives — prefer `RouteChanged` over `AnnounceRoute`.
- `Native` / `Web` axis throughout (not `Host` / `Page`, which were
  overloaded in the previous design).

## Buffered dispatcher lifecycle

Per tag, the dispatcher is in one of three states:

- **idle** — no listener has ever been registered. Incoming messages
  buffer in a per-tag queue.
- **live** — a listener is registered. Incoming messages dispatch
  directly to the listener.
- **disposed** — the listener has been disposed (or the dispatcher has
  been disposed wholesale). Incoming messages drop with a
  `console.warn`.

Transitions:

- `idle → live` — first `setMessageListener(tag, listener)`. Drains the
  queue to the listener in arrival order, then live-delivers.
- `live → disposed` — the disposer returned by `setMessageListener` runs.
- Re-registering after `disposed` throws. Re-registering during `live`
  warns and replaces (the prior disposer becomes a no-op via identity
  check).

`consumeBuffered(tag)` drains the current queue without touching state.
The tag stays `idle` (or `live`, if already subscribed — in which case
the queue is already empty). Use this before React mounts to peek the
initial route from the buffered `AppNavigationRequested`.

`dispose()` (on the handler) transitions every tag to `disposed` and
warns once with a summary if any queues were non-empty (e.g.
`'[interop] disposed with un-consumed messages: Foo (2), Bar (1)'`).

## `__INITIAL_MESSAGES__`

The Expo host injects `window.__INITIAL_MESSAGES__ = JSON.stringify([...])`
via `injectedJavaScriptBeforeContentLoaded`. The web handler reads,
decodes, and dispatches each entry on construction (before React mounts),
then deletes the global so a hot reload doesn't double-replay.

The pre-encoded entries follow the same wire format as runtime
`postMessage` traffic, so any tag in the combined `NativeToWeb` record
can ride this channel — typically the initial `AppNavigationRequested`
for the route and slice-specific one-shots like `AuthTokenIssued`.

## Origin/source filtering

`makeWebMessageHandler` only acts on `MessageEvent`s where:

- `event.source === window` — RN's `injectJavaScript` posts via
  `window.postMessage`, so legitimate events have the page itself as
  source.
- `event.origin === window.location.origin` (or `''` for `data:` /
  `file://` schemes used by embedded HTML).

Cross-origin frames, browser extensions, and arbitrary message-channel
ports are ignored.

## Disposal expectations

- Single-listener-per-tag: register once, dispose once. Replacing a live
  listener emits a warning (the previous registration leaked).
- Calling a stale disposer (after replacement) is a safe no-op.
- After `MessageHandler.dispose()`, do not re-use the handler. Construct
  a new one if a re-mount is needed.

## Slice authoring guide

To add messages to a slice:

1. Add `<slice>-core/src/message-schemas.ts` with the schemas plus two
   directional records (`<Slice>NativeToWeb`, `<Slice>WebToNative`).
   Empty record is `makeMessageRecord([] as const)`.
2. Add `<slice>-{web,react}/src/contexts/<Slice>WebMessageHandler.ts` —
   `Context.Tag<MessageHandler<NativeToWeb, WebToNative>>` and a
   `make<Slice>WebMessageHandlerLayer(handler)` factory.
3. Add `<slice>-expo/src/contexts/<Slice>ExpoMessageHandler.ts` —
   mirrors with directions swapped.
4. The aggregator spreads the slice records into the combined per-direction
   records and supplies the constructed handler to each slice's context.

## File-layout convention

Start with one `message-schemas.ts` per slice. Split into a folder
`<slice>-core/src/message-schemas/<Tag>.ts` only when the file becomes
unwieldy. Mirror the barrel pattern used by `<slice>-core/livestore/`.
