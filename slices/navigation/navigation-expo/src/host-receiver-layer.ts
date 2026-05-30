import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'

/**
 * Build the host-side `ReceiverLayer` for {@link NavigationBridge}.
 *
 * @param onRouteChanged - Invoked for each `RouteChanged`. Omitted: the
 *   handler is a no-op (acknowledged, no side effect).
 * @param onUIReady - Invoked once when the embedded SPA posts `UIReady`
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
const ReceiverLayer = (
  onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void,
  onUIReady?: () => void
): Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>> =>
  NavigationBridge.Host.ReceiverLayer({
    RouteChanged: ({ pathname, canGoBack }) =>
      Effect.sync(() => onRouteChanged?.({ pathname, canGoBack })),
    UIReady: () => Effect.sync(() => onUIReady?.()),
  })

export { ReceiverLayer }
