import { Effect } from 'effect'
import { type HostBinding, LogBridge, type LogLevel, type LogPayload } from 'effect-messaging-core'
import { useMemo } from 'react'

/** Optional override for the host-side `Log` handler. */
interface UseLogHostBindingOptions {
  /**
   * Custom handler for decoded `Log` messages. When omitted, the default
   * surfaces each `Log` through `Effect.log<Level>(...payload)` — same
   * mapping {@link LogBridge.defaultHostReceiverLayer} encodes, kept as
   * the parameter default (not a body-level ternary) so the entry point
   * documents the fallback at the call site.
   */
  readonly onLog?: (log: LogPayload) => Effect.Effect<void>
}

/**
 * Map a wire log level to its matching Effect logger entry point. `'log'`
 * mirrors the browser console's INFO-level alias — Effect has no
 * distinct "log" rung, so it lands at INFO alongside `'info'`.
 *
 * @remarks
 * Duplicates {@link LogBridge.defaultHostReceiverLayer}'s internal table
 * because the default exists inside a closed-over `Layer.succeed`; the
 * caller-supplied `onLog` path needs an independent surface to invoke.
 */
const effectLogFor: Record<LogLevel, (...args: ReadonlyArray<unknown>) => Effect.Effect<void>> = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  log: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
}

/** Default `onLog`: spread the wire payload through the matching `Effect.log<Level>`. */
const defaultOnLog = ({ level, payload }: LogPayload): Effect.Effect<void> =>
  effectLogFor[level](...payload)

/**
 * Host binding for {@link LogBridge}. Returns a memoised
 * {@link HostBinding.HostBinding} keyed on the (optional) `onLog`
 * override so callers can pass the result directly into a
 * `BridgedWebView`'s `bindings` tuple alongside slice-specific
 * bindings.
 *
 * @remarks
 * Mirrors the shape of slice-level `use<Slice>HostBinding` hooks
 * (`useNavigationHostBinding`, etc.) — `bridge`, `receiverLayer`, no
 * `initialMessages` (the bridge is Web→Host only). The web-side wiring
 * lives in {@link LogBridge.installConsoleInterceptor}, called inside
 * an `onTransportReady` step at the embedded SPA's transport build
 * site, not here.
 */
const useLogHostBinding = ({
  onLog = defaultOnLog,
}: UseLogHostBindingOptions = {}): HostBinding.HostBinding<typeof LogBridge> =>
  useMemo(
    () => ({
      bridge: LogBridge,
      receiverLayer: LogBridge.Host.ReceiverLayer({
        Log: onLog,
      }),
    }),
    [onLog]
  )

export { useLogHostBinding }
export type { UseLogHostBindingOptions }
