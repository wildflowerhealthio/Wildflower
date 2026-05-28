import { type Effect } from 'effect'
import { HostBindings, LogBridge } from 'effect-messaging-core'
import { useMemo } from 'react'

/** Optional override for the host-side `Log` handler. */
interface UseLogHostBindingOptions {
  /**
   * Custom handler for decoded `Log` messages. When omitted, the default
   * is {@link LogBridge.defaultOnLog} — surfaces each `Log` through
   * `Effect.log<Level>(...payload)`. Kept as the parameter default (not
   * a body-level ternary) so the entry point documents the fallback at
   * the call site.
   */
  readonly onLog?: (log: LogBridge.LogPayload) => Effect.Effect<void>
}

/**
 * Host binding for {@link LogBridge.LogBridge}. Returns a memoised
 * {@link HostBindings.HostBindings} keyed on the (optional) `onLog`
 * override so callers can pass the result directly into a
 * `BridgedWebView`'s `bindings` (via `HostBindings.combine(...)`)
 * alongside slice-specific bindings.
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
  onLog = LogBridge.defaultOnLog,
}: UseLogHostBindingOptions = {}): HostBindings.HostBindings<
  readonly [typeof LogBridge.LogBridge]
> =>
  useMemo(
    () =>
      HostBindings.single({
        bridge: LogBridge.LogBridge,
        receiverLayer: LogBridge.LogBridge.Host.ReceiverLayer({
          Log: onLog,
        }),
      }),
    [onLog]
  )

export { useLogHostBinding }
export type { UseLogHostBindingOptions }
