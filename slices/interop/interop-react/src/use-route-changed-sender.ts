import type { MessageWriter, RouteChanged } from 'interop-core'
import { useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigationType } from 'react-router'

/**
 * Mount under a React Router router and have the writer emit a
 * `RouteChanged` message on every navigation. `canGoBack` tracks whether
 * the in-page history depth is > 0 — Push deepens, Pop shallows; Replace
 * leaves depth alone — so the native screen header's back chevron
 * disappears on the initial route and reappears as the user pushes.
 */
const useRouteChangedSender = (
  writer: MessageWriter<{ readonly RouteChanged: typeof RouteChanged }>
): void => {
  const location = useLocation()
  const navigationType = useNavigationType()
  const depthRef = useRef(0)

  useEffect(() => {
    if (navigationType === NavigationType.Push) depthRef.current += 1
    else if (navigationType === NavigationType.Pop)
      depthRef.current = Math.max(0, depthRef.current - 1)
    writer.sendMessage({
      _tag: 'RouteChanged',
      pathname: location.pathname,
      canGoBack: depthRef.current > 0,
    })
  }, [location.key, location.pathname, navigationType, writer])
}

export { useRouteChangedSender }
