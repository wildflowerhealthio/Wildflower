import type { Effect } from 'effect'
import { type BridgeTransport, HostBindings } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'
import { makeNavigationHostHandlers } from './host-handlers.ts'

interface UseNavigationHostBindingOptions {
  /** Initial SPA route; seeded via the URL-param channel. */
  readonly initialRoute?: string
  /** Fires when the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void
  /**
   * Fires once when the SPA emits `UIReady` (auth gate passed + startup
   * prefetches settled). The host hides the native splash / reveals the
   * WebView here. Callers must stabilise this themselves — it's in the
   * memo's dep list.
   */
  readonly onUiReady?: () => void
  /**
   * Invoked every time the page posts `__Ready` — first WebView load
   * and every subsequent reload. Receives the typed sender for outbound
   * navigation messages; the host shell typically captures it into a
   * ref so a sibling tab bar can dispatch into the same transport.
   * Repeat firings re-write the same sender (its identity is stable for
   * the transport's lifetime), so the body needs no per-load guard.
   */
  readonly onPageReady?: (
    send: BridgeTransport.MessageSender<readonly [typeof NavigationBridge], 'HostToWeb'>
  ) => Effect.Effect<void>
}

/**
 * Host binding for the navigation bridge. Combines the handler record
 * with an optional `HostRequestedWebNavigation` initial message, and
 * surfaces the transport's typed sender via `onPageReady` so a sibling
 * consumer (e.g. a native tab bar) can dispatch through it.
 *
 * @remarks
 * Callers must stabilise `onRouteChanged` themselves (e.g. with
 * `useCallback`) — it's in the memo's dep list, and an unstable
 * reference re-runs `HostBindings.combine` and rebuilds the WebView
 * transport on every host render.
 *
 * Cross-process `Log` mirroring used to ride this binding via an
 * `onLog` option; it's now on the shared `LogBridge` (compose
 * `useLogHostBinding()` from `effect-messaging-expo` alongside).
 *
 * @example
 * ```tsx
 * const onRouteChanged = useCallback((r) => setRoute(r), [setRoute])
 * const onPageReady = useCallback(
 *   (send) => Effect.sync(() => setNavigationSender(send)),
 *   [setNavigationSender]
 * )
 * const binding = NavigationBridgeExpo.useHostBinding({
 *   initialRoute,
 *   onRouteChanged,
 *   onPageReady,
 * })
 * ```
 */
const useNavigationHostBinding = ({
  initialRoute,
  onRouteChanged,
  onUiReady,
  onPageReady,
}: UseNavigationHostBindingOptions = {}): HostBindings.HostBindings<
  readonly [typeof NavigationBridge]
> =>
  useMemo(
    () =>
      HostBindings.single({
        bridge: NavigationBridge,
        handlers: makeNavigationHostHandlers(onRouteChanged, onUiReady),
        initialMessages:
          initialRoute === undefined
            ? undefined
            : [{ _tag: 'HostRequestedWebNavigation' as const, path: initialRoute }],
        onPageReady,
      }),
    [initialRoute, onRouteChanged, onUiReady, onPageReady]
  )

export { useNavigationHostBinding }
export type { UseNavigationHostBindingOptions }
