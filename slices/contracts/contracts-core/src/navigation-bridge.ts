import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * Host → Web: the Expo host has detected a back-navigation gesture
 * (header chevron tap, hardware back, swipe-back). The web side is
 * expected to call `navigate(-1)` (or equivalent) so the embedded SPA's
 * history pops without popping the native screen.
 */
const HostBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))
type HostBackRequested = Schema.Schema.Type<typeof HostBackRequested>

/**
 * Host → Web: the host requests the embedded SPA navigate to `path`.
 * Two complementary use cases:
 *
 * 1. **Initial route.** The host pre-encodes one of these into
 *    `__INITIAL_MESSAGES__` so the web aggregator can synchronously
 *    seed `<MemoryRouter initialEntries={[path]}>` before mount.
 * 2. **Runtime navigation.** A live `HostRequestedWebNavigation` after
 *    mount is delivered to a listener that calls the embedded router's
 *    imperative `navigate(path)` — useful for host-driven deep links.
 *
 * Direction reads from the name: the *Host* side requests a *Web*
 * navigation. (The complementary "page asks the host to push the
 * *native* router" direction is reserved for a future tag.)
 */
const HostRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('HostRequestedWebNavigation', { path: Schema.String })
)
type HostRequestedWebNavigation = Schema.Schema.Type<typeof HostRequestedWebNavigation>

/**
 * Web → Host: the embedded SPA's router state has changed. `canGoBack`
 * drives the native screen header's back chevron; `pathname` is
 * informational (used by the host for analytics or deep-link continuity).
 */
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', {
    pathname: Schema.String,
    canGoBack: Schema.Boolean,
  })
)
type RouteChanged = Schema.Schema.Type<typeof RouteChanged>

const hostOptionsShape = Schema.Struct({ initialPath: Schema.String })
const webOptionsShape = Schema.Struct({})

type NavigationBridge = Bridge.Bridge<
  'Navigation',
  {
    HostBackRequested: typeof HostBackRequested
    HostRequestedWebNavigation: typeof HostRequestedWebNavigation
  },
  {
    RouteChanged: typeof RouteChanged
  },
  typeof hostOptionsShape,
  typeof webOptionsShape
>
/**
 * Slice-neutral cross-process navigation contract. The host emits
 * `HostBackRequested` and `HostRequestedWebNavigation`; the page
 * emits `RouteChanged`. Aggregators wire `NavigationBridge` into every
 * embedded WebView — initial route, back chevron, and host deep links
 * all flow through this one bridge.
 *
 * `hostOptionsShape` describes the per-WebView options the Expo
 * aggregator passes to construct the initial message (`{ initialPath }`
 * → encoded `HostRequestedWebNavigation`). `webOptionsShape` is empty
 * — the web aggregator has no per-bridge configuration to pass.
 */
const NavigationBridge: NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
  ] as const,
  webToHost: [['RouteChanged', RouteChanged]] as const,
  hostOptionsShape,
  webOptionsShape,
})

export default NavigationBridge
