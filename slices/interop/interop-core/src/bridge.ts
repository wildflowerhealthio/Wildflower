import { Schema } from 'effect'
import { defineBridge } from './define-bridge.ts'

/**
 * Native → Web: the Expo host has detected a back-navigation gesture
 * (header chevron tap, hardware back, swipe-back). The web side is
 * expected to call `navigate(-1)` (or equivalent) so the embedded SPA's
 * history pops without popping the native screen.
 */
const NativeBackRequested = Schema.parseJson(Schema.TaggedStruct('NativeBackRequested', {}))
type NativeBackRequested = Schema.Schema.Type<typeof NativeBackRequested>

/**
 * Native → Web: the host requests the embedded SPA navigate to `path`.
 * Two complementary use cases:
 *
 * 1. **Initial route.** The host pre-encodes one of these into
 *    `__INITIAL_MESSAGES__` so the web aggregator can synchronously
 *    seed `<MemoryRouter initialEntries={[path]}>` before mount.
 * 2. **Runtime navigation.** A live `NativeRequestedWebNavigation` after
 *    mount is delivered to a listener that calls the embedded router's
 *    imperative `navigate(path)` — useful for host-driven deep links.
 *
 * Direction reads from the name: the *Native* side requests a *Web*
 * navigation. (The complementary "page asks the host to push the
 * *native* router" direction is reserved for a future tag.)
 */
const NativeRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('NativeRequestedWebNavigation', { path: Schema.String })
)
type NativeRequestedWebNavigation = Schema.Schema.Type<typeof NativeRequestedWebNavigation>

/**
 * Web → Native: the embedded SPA's router state has changed. `canGoBack`
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

/**
 * Slice-neutral cross-process navigation contract. The host emits
 * `NativeBackRequested` and `NativeRequestedWebNavigation`; the page
 * emits `RouteChanged`. Aggregators wire `NavigationBridge` into every
 * embedded WebView — initial route, back chevron, and host deep links
 * all flow through this one bridge.
 *
 * `nativeOptionsShape` describes the per-WebView options the Expo
 * aggregator passes to construct the initial message (`{ initialPath }`
 * → encoded `NativeRequestedWebNavigation`). `webOptionsShape` is empty
 * — the web aggregator has no per-bridge configuration to pass.
 */
const NavigationBridge = defineBridge({
  name: 'Navigation',
  nativeToWeb: [
    ['NativeBackRequested', NativeBackRequested],
    ['NativeRequestedWebNavigation', NativeRequestedWebNavigation],
  ] as const,
  webToNative: [['RouteChanged', RouteChanged]] as const,
  nativeOptionsShape: Schema.Struct({ initialPath: Schema.String }),
  webOptionsShape: Schema.Struct({}),
})

export { NativeBackRequested, NativeRequestedWebNavigation, NavigationBridge, RouteChanged }
export type {
  NativeBackRequested as NativeBackRequestedType,
  NativeRequestedWebNavigation as NativeRequestedWebNavigationType,
  RouteChanged as RouteChangedType,
}
