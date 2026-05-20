import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'

/**
 * Build the host-side `ReceiverLayer` for {@link NavigationBridge},
 * closing handlers over caller-supplied callbacks for the two web→host
 * messages.
 *
 * Designed for an Expo app shell that embeds the SPA in a WebView:
 * `onRouteChanged` drives native chrome (tab highlight, back chevron,
 * splash-reveal handshake) from the SPA's `RouteChanged` events, while
 * `onLog` is the host's escape hatch for SPA-side `Log` messages.
 *
 * Both callbacks are optional:
 *
 *  - `onRouteChanged` omitted: `RouteChanged` is acknowledged but no
 *    side effect runs.
 *  - `onLog` omitted: falls back to `Effect.log`, matching the historical
 *    inline behaviour where SPA logs surface through the host's Effect
 *    logger.
 */
const ReceiverLayer = (
  onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void,
  onLog?: (log: string) => Effect.Effect<void>
): Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>> =>
  NavigationBridge.Host.ReceiverLayer({
    RouteChanged: ({ pathname, canGoBack }) =>
      Effect.sync(() => onRouteChanged?.({ pathname, canGoBack })),
    Log: ({ log }) => (onLog ?? Effect.log)(log),
  })

export { ReceiverLayer }
