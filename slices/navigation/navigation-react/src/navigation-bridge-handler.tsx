import { useCanGoBack, useLocation } from '@tanstack/react-router'
import { Effect } from 'effect'
import type { NavigationBridge } from 'navigation-core'
import { type JSX, useEffect, useRef } from 'react'

/**
 * Sender shape consumers actually have: same input as
 * `NavigationBridge.Web.send` but with `BareSender` already discharged
 * (because `transport.sendMessage` provides it internally). Keeping the
 * input typed via `Parameters` preserves `_tag`-narrowing at the call
 * site without re-deriving it from `OutboundSchemas`.
 */
type RouteChangeSender = (
  message: typeof NavigationBridge.Web.OutboundSchemas.RouteChanged.Type
) => Effect.Effect<void>

/**
 * Observe every router navigation and emit a `RouteChanged` message.
 * `canGoBack` comes straight from `useCanGoBack()` (TanStack Router's
 * own back-availability hook), so the native header's back chevron
 * disappears on the initial route and reappears as the user pushes —
 * without re-deriving history depth in user space.
 */
const useRouteChangeWatcher = (send: RouteChangeSender): void => {
  const location = useLocation()
  const canGoBack = useCanGoBack()

  // Keep `send` out of the effect dep array — callers commonly pass an
  // inline closure, and we'd otherwise refire on every parent re-render
  // (the bridge would emit a spurious `RouteChanged` with no actual
  // navigation). The ref always points to the latest sender, so the
  // effect closes over a stable identity while still using current
  // behaviour.
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })

  useEffect(() => {
    // `send` returns an `Effect`; constructing one and discarding it
    // is a silent no-op. `useEffect` callbacks can't be Effect-aware,
    // so detach-fork it onto the default runtime.
    Effect.runFork(
      sendRef.current({
        _tag: 'RouteChanged',
        pathname: location.pathname,
        canGoBack,
      })
    )
  }, [location.pathname, location.state, canGoBack])
}

/**
 * Mount under a TanStack `<RouterProvider>`. Watches navigation to emit
 * `RouteChanged`. Renders no DOM.
 *
 * @remarks
 * Inbound navigation messages (`HostBackRequested`,
 * `HostRequestedWebNavigation`) are handled by the record built via
 * {@link makeNavigationWebHandlers} — call that inside a component with
 * `useNavigate()` access and pass the record to `BridgeTransport.make`'s
 * `handlers`.
 */
function NavigationBridgeHandler({ sender }: { sender: RouteChangeSender }): JSX.Element | null {
  useRouteChangeWatcher(sender)

  return null
}

export { NavigationBridgeHandler }
export type { RouteChangeSender }
