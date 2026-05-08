import type { NavigationBridge } from 'contracts-core'
import { useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigationType } from 'react-router'

/**
 * Mount under a React Router router; observe every navigation and emit
 * a `RouteChanged` message describing it. `canGoBack` tracks whether
 * the in-page history depth is > 0 — Push deepens, Pop shallows;
 * Replace leaves depth alone — so the native screen header's back
 * chevron disappears on the initial route and reappears as the user
 * pushes.
 *
 * The hook's job is mostly observing router state; the message dispatch
 * is the (sole) side-effect. Takes a typed sender
 * (e.g. `NavigationBridge.Web.send` or the merged
 * `transport.sendMessage`).
 */
const useRouteChangeWatcher = (
  send: (message: NavigationBridge['MessageSchemas']['RouteChanged']['Type']) => void
): void => {
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

export { useRouteChangeWatcher }
