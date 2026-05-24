import { Effect } from 'effect'
import type { NavigationBridge } from 'navigation-core'
import { type JSX, useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigationType } from 'react-router'

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
 * `canGoBack` tracks in-page history depth (Push deepens, Pop shallows;
 * Replace leaves depth alone) so the native header's back chevron
 * disappears on the initial route and reappears as the user pushes.
 */
const useRouteChangeWatcher = (send: RouteChangeSender): void => {
  const location = useLocation()
  const navigationType = useNavigationType()
  const depthRef = useRef(0)

  useEffect(() => {
    if (navigationType === NavigationType.Push) depthRef.current += 1
    else if (navigationType === NavigationType.Pop)
      depthRef.current = Math.max(0, depthRef.current - 1)
    // `send` returns an `Effect`; constructing one and discarding it
    // is a silent no-op. `useEffect` callbacks can't be Effect-aware,
    // so detach-fork it onto the default runtime.
    Effect.runFork(
      send({
        _tag: 'RouteChanged',
        pathname: location.pathname,
        canGoBack: depthRef.current > 0,
      })
    )
  }, [location.key, location.pathname, navigationType, send])
}

/**
 * Mount under a React Router router. Watches navigation to emit
 * `RouteChanged`. Renders no DOM.
 *
 * @remarks
 * Inbound navigation messages (`HostBackRequested`,
 * `HostRequestedWebNavigation`) are handled by the receiver Layer
 * built via {@link makeNavigationWebReceiverLayer} — call that inside
 * a component with `useNavigate()` access and pass the layer to
 * `BridgeTransport.make`.
 */
function NavigationBridgeHandler({ sender }: { sender: RouteChangeSender }): JSX.Element | null {
  useRouteChangeWatcher(sender)

  return null
}

export { NavigationBridgeHandler }
export type { RouteChangeSender }
