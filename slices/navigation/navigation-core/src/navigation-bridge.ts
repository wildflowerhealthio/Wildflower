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
 * pre-injected initial route (read synchronously to seed
 * `<MemoryRouter initialEntries={[path]}>`) and runtime host-driven
 * deep links.
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

type NavigationBridge = Bridge.Bridge<
  'Navigation',
  {
    HostBackRequested: typeof HostBackRequested
    HostRequestedWebNavigation: typeof HostRequestedWebNavigation
  },
  {
    RouteChanged: typeof RouteChanged
  }
>
/**
 * Slice-neutral cross-process navigation contract. Host emits
 * `HostBackRequested` and `HostRequestedWebNavigation`; web emits
 * `RouteChanged`. Aggregators wire this bridge into every embedded WebView.
 */
const NavigationBridge: NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
  ] as const,
  webToHost: [['RouteChanged', RouteChanged]] as const,
  urlParams: {
    HostRequestedWebNavigation: UrlParamMessage.singleStringMessageSchema(
      'HostRequestedWebNavigation',
      'path'
    ),
    // HostBackRequested deliberately omitted — it's a runtime-only signal.
  },
})

export default NavigationBridge
