import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import type { NavigationBridge } from 'navigation-core'

/**
 * Build the host-side inbound handler record for {@link NavigationBridge}.
 *
 * @param onRouteChanged - Invoked for each `RouteChanged`. Omitted: the
 *   handler is a no-op (acknowledged, no side effect).
 * @param onUiReady - Invoked once when the embedded SPA posts `UIReady`
 *   (auth gate passed + startup prefetches settled). The host typically
 *   hides the native splash / reveals the WebView here. Omitted: no-op.
 *
 * @remarks
 * Cross-process `Log` mirroring used to ride this bridge; it's now on
 * the shared `LogBridge` (composed alongside via `useLogHostBinding()`
 * from `effect-messaging-expo`). New `-expo` slices should follow the
 * same split — wire `useLogHostBinding()` next to the slice's host
 * binding rather than re-adding a `Log` channel here.
 */
const makeNavigationHostHandlers = (
  onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void,
  onUiReady?: () => void
): Bridge.HalfHandlers<(typeof NavigationBridge)['Host']> => ({
  RouteChanged: ({ pathname, canGoBack }) =>
    Effect.sync(() => onRouteChanged?.({ pathname, canGoBack })),
  UIReady: () => Effect.sync(() => onUiReady?.()),
})

export { makeNavigationHostHandlers }
