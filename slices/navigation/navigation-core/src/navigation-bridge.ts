import { Schema } from 'effect'
import { Bridge, UrlParamMessage } from 'effect-messaging-core'

/**
 * Host → Web: Expo host detected a back-navigation gesture (header chevron,
 * hardware back, swipe-back). The web side calls `navigate(-1)` so the
 * embedded SPA's history pops without popping the native screen.
 */
const HostBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))

/**
 * Host → Web: navigate the embedded SPA to `path`. Carries both the
 * pre-injected initial route (read synchronously to seed the TanStack
 * router's `createMemoryHistory({ initialEntries: [path] })`) and
 * runtime host-driven deep links.
 */
const HostRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('HostRequestedWebNavigation', { path: Schema.String })
)

/**
 * Web → Host: embedded SPA router state has changed. `canGoBack` drives
 * the native header's back chevron; `pathname` is informational.
 */
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', {
    pathname: Schema.String,
    canGoBack: Schema.Boolean,
  })
)

/**
 * Web → Host: the embedded SPA's first authed screen is ready to be
 * shown — the `beforeLoad` auth gate passed (host token received) and
 * the startup route prefetches have settled. The host reacts by hiding
 * the native splash / revealing the WebView, so the user never sees a
 * half-painted or unauthenticated frame.
 *
 * A lifecycle handshake modeled on the transport's `__Ready` control
 * message, but at the application layer (auth + data) rather than the
 * transport layer — `__Ready` says "the page can receive messages,"
 * `UIReady` says "the page has something worth showing."
 */
const UIReady = Schema.parseJson(Schema.TaggedStruct('UIReady', {}))

type NavigationBridge = Bridge.Bridge<
  'Navigation',
  {
    HostBackRequested: typeof HostBackRequested
    HostRequestedWebNavigation: typeof HostRequestedWebNavigation
  },
  {
    RouteChanged: typeof RouteChanged
    UIReady: typeof UIReady
  }
>

/**
 * Slice-neutral cross-process navigation contract. Host emits
 * `HostBackRequested` and `HostRequestedWebNavigation`; web emits
 * `RouteChanged`. Aggregators wire this bridge into every embedded WebView.
 *
 * @remarks
 * Cross-process `console.<level>(...)` mirroring is handled by the
 * shared `LogBridge` in `effect-messaging-core`; consumers compose it
 * alongside this bridge via `useLogHostBinding()` from
 * `effect-messaging-expo`.
 */
const NavigationBridge: NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
  ] as const,
  webToHost: [
    ['RouteChanged', RouteChanged],
    ['UIReady', UIReady],
  ] as const,
  urlParams: {
    HostRequestedWebNavigation: UrlParamMessage.singleStringMessageSchema(
      'HostRequestedWebNavigation',
      'path'
    ),
    // HostBackRequested deliberately omitted — it's a runtime-only signal.
  },
})

export { NavigationBridge }
