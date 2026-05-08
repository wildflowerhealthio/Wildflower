import type { Schema } from 'effect'
import type { RouteChanged } from 'interop-core'
import { useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigationType } from 'react-router'

type RouteChangedMessage = Schema.Schema.Type<typeof RouteChanged>

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
 * (e.g. `NavigationBridge.Web.makeSender(...)` or the merged
 * `transport.sendMessage`).
 */
const useRouteChangeWatcher = (send: (message: RouteChangedMessage) => void): void => {
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
export type { RouteChangedMessage }
