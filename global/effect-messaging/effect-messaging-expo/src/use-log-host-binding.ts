import { type Effect } from 'effect'
import { HostBindings, Logging } from 'effect-messaging-core'
import { useMemo } from 'react'

/** Optional override for the host-side `Log` handler. */
interface UseLogHostBindingOptions {
  /**
   * Custom handler for decoded `Log` messages. When omitted, the default
   * is {@link Logging.defaultOnLog} — surfaces each `Log` through
   * `Effect.log<Level>(...payload)`. Kept as the parameter default (not
   * a body-level ternary) so the entry point documents the fallback at
   * the call site.
   */
  readonly onLog?: (log: Logging.LogPayload) => Effect.Effect<void>
}

/**
 * Host binding for {@link Logging.LogBridge}. Returns a memoised
 * {@link HostBindings.HostBindings} keyed on the (optional) `onLog`
 * override so callers can pass the result directly into a
 * `BridgedWebView`'s `bindings` (via `HostBindings.combine(...)`)
 * alongside slice-specific bindings.
 *
 * @remarks
 * Mirrors the shape of slice-level `use<Slice>HostBinding` hooks
 * (`useNavigationHostBinding`, etc.) — `bridge`, `receiverLayer`, no
 * `initialMessages` (the bridge is Web→Host only). The web-side wiring
 * lives in {@link Logging.installConsoleInterceptor}, called inside
 * an `onTransportReady` step at the embedded SPA's transport build
 * site, not here.
 */
const useLogHostBinding = ({
  onLog = Logging.defaultOnLog,
}: UseLogHostBindingOptions = {}): HostBindings.HostBindings<readonly [typeof Logging.LogBridge]> =>
  useMemo(
    () =>
      HostBindings.single({
        bridge: Logging.LogBridge,
        receiverLayer: Logging.LogBridge.Host.ReceiverLayer({
          Log: onLog,
        }),
      }),
    [onLog]
  )

export { useLogHostBinding }
export type { UseLogHostBindingOptions }
