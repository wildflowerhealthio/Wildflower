import type { NavigationBridge } from 'navigation-core'
import { type JSX, useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigationType } from 'react-router'

/**
 * Observe every router navigation and emit a `RouteChanged` message.
 * `canGoBack` tracks in-page history depth (Push deepens, Pop shallows;
 * Replace leaves depth alone) so the native header's back chevron
 * disappears on the initial route and reappears as the user pushes.
 */
const useRouteChangeWatcher = (send: typeof NavigationBridge.Web.send): void => {
  const location = useLocation()
  const navigationType = useNavigationType()
  const depthRef = useRef(0)

  useEffect(() => {
    if (navigationType === NavigationType.Push) depthRef.current += 1
    else if (navigationType === NavigationType.Pop)
      depthRef.current = Math.max(0, depthRef.current - 1)
    send({
      _tag: 'RouteChanged',
      pathname: location.pathname,
      canGoBack: depthRef.current > 0,
    })
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
function NavigationBridgeHandler({
  sender,
}: {
  sender: typeof NavigationBridge.Web.send
}): JSX.Element | null {
  useRouteChangeWatcher(sender)

  return null
}

export { NavigationBridgeHandler }
