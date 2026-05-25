import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'

/** Console-method levels mirrored on the wire by {@link NavigationBridge}'s `Log` message. */
type LogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'

/** Structured payload the host receives for each SPA-side console emission. */
interface LogMessage {
  readonly level: LogLevel
  readonly payload: readonly unknown[]
}

/**
 * Map a wire log level to its matching Effect logger entry point. `'log'`
 * mirrors the browser console's INFO-level alias.
 */
const effectLogFor: Record<LogLevel, (...args: ReadonlyArray<unknown>) => Effect.Effect<void>> = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  log: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
}

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
 *  - `onLog` omitted: falls back to the matching `Effect.log<Level>`
 *    function spread over the message's `payload`, surfacing SPA logs
 *    through the host's Effect logger at the original console level.
 */
const ReceiverLayer = (
  onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void,
  onLog?: (log: LogMessage) => Effect.Effect<void>
): Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>> =>
  NavigationBridge.Host.ReceiverLayer({
    RouteChanged: ({ pathname, canGoBack }) =>
      Effect.sync(() => onRouteChanged?.({ pathname, canGoBack })),
    Log: ({ level, payload }) =>
      onLog === undefined ? effectLogFor[level](...payload) : onLog({ level, payload }),
  })

export { ReceiverLayer }
export type { LogLevel, LogMessage }
