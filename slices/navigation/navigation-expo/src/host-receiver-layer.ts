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
 * Build the host-side `ReceiverLayer` for {@link NavigationBridge}.
 *
 * @param onRouteChanged - Invoked for each `RouteChanged`. Omitted: the
 *   handler is a no-op (acknowledged, no side effect).
 * @param onLog - Invoked for each `Log`. Omitted: falls back to
 *   `Effect.log<Level>(...payload)` so SPA logs surface through the
 *   host's Effect logger at the original console level.
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
