# Interop Packages Explanation

The `interop` slice owns the cross-process bridge between the embedded React
SPA (`apps/wildflower-react`) and its Expo host (`apps/wildflower`). Three
packages, layered as core → platform adapters:

## interop-core

Pure, runtime-neutral. No DOM, no React, no Expo, no React Native. Owns:

- The **Message** primitive — `Schema.Schema<A, string>` where `A` is a
  `_tag`-tagged record. Exchange-format is a string (JSON by default via
  `Schema.parseJson(Schema.TaggedStruct(...))`).
- `MessageSchemaRecord` and `makeMessageRecord([['Tag', schema], ...] as const)`
  — type-checked tag-keyed dictionaries used to compose slice vocabularies.
- `MessageReader` / `MessageWriter` / `MessageHandler` interfaces.
- `makeBufferedDispatcher` — transport-free per-tag buffer + listener
  registry. Single-listener-per-tag with explicit pre-listener buffering;
  see [Reference](./Reference.md) for the lifecycle invariants.
- The slice-neutral interop messages: `NativeBackRequested`,
  `AppNavigationRequested`, `RouteChanged`, plus the directional records
  `InteropNativeToWeb` and `InteropWebToNative`.
- `SURFACE_QUERY_KEY` / `SURFACE_EXPO` constants for the `?surface=expo`
  URL marker.

## interop-react

Browser adapter. Wraps `interop-core` to bridge `window.postMessage` /
`addEventListener('message')` and the React-Native-WebView injection of
`window.__INITIAL_MESSAGES__` to a `MessageHandler`. Also provides:

- `makeWebMessageHandler({ receive, send })` — constructs the handler,
  reads and clears `window.__INITIAL_MESSAGES__` synchronously, listens for
  postMessage events with origin/source filtering, and posts outgoing
  messages via `window.ReactNativeWebView.postMessage`.
- `<NavigateRefBinder>` — populates a module-scoped `navigateRef` from
  `useNavigate()` and flushes any queued `NativeBackRequested` events that
  arrived before React mounted.
- `useRouteChangedSender` — subscribes to React Router state and emits a
  `RouteChanged` message on each navigation.
- `readUrlParam` / `consumeUrlParam` / `readSurface` URL helpers.

The plain-JS surface (handler construction, `consumeBuffered`, native-back
listener registration) is meant to run _before_ React mounts so the
aggregator can seed `<MemoryRouter initialEntries=[...]>` from the buffered
`AppNavigationRequested` and avoid a placeholder-route flicker.

## interop-expo

Expo / React Native adapter. Wraps `interop-core` to bridge
`react-native-webview`'s `onMessage` / `webviewRef.postMessage` to a
`MessageHandler`. Owns:

- `EmbeddedWebView` — a React Native `WebView` wrapper that exposes a
  pure transport surface. Loader overlay dismissed on `onLoadEnd`; first
  navigation owned, subsequent navigations redirected to the system
  browser; back-chevron header driven by the consumer (no built-in
  protocol).
- `makeExpoMessageHandler({ receive, send }, webviewRef, initialMessages)` —
  constructs the handler and the `injectedScript` that publishes
  `window.__INITIAL_MESSAGES__` before the page bundle runs.
- `useMessageHandler` — React hook that ties the WebView ref + initial
  messages to a handler and returns the props to spread onto
  `EmbeddedWebView`.

## How the three compose

```text
                interop-core
                /    |     \
   interop-react     |      interop-expo
        |            |             |
  apps/wildflower-react           apps/wildflower
  (embedded SPA)                  (Expo host)
```

Slices that own messages (e.g. `gatekeeper`) export their own message
schemas in `<slice>-core/src/message-schemas.ts` and per-platform
`Context.Tag` + `Layer` factories in
`<slice>-{web,react,expo}/src/contexts/<Slice>{Web,Expo}MessageHandler.ts`.
Aggregators spread the slice records into a single combined record per
direction and construct one platform handler per WebView surface.
