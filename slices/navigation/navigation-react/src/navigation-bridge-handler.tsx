import { Match, Option } from 'effect'
import type { NavigationBridge } from 'navigation-core'
import { type JSX, useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router'
import * as WindowNavigationState from './internal/window-navigation-state'
import type { NavTarget } from './internal/window-navigation-state'

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

const useNavigateHandlerUpdater = (): void => {
  const navigate = useNavigate()

  useEffect(() => {
    // Split number/string branches so React Router's `navigate` overload picks the right signature.
    const handler = Match.type<NavTarget>().pipe(
      Match.when(Match.number, (to) => void navigate(to)),
      Match.when(Match.string, (to) => void navigate(to)),
      Match.exhaustive
    )

    const maybeHandler = Option.some(handler)
    WindowNavigationState.navigateFunctionRef.current = maybeHandler

    while (WindowNavigationState.pendingNavigations.length > 0) {
      const entry = WindowNavigationState.pendingNavigations.shift()
      if (entry === undefined) break
      handler(entry)
    }
    return (): void => {
      // oxlint-disable eslint-plugin-react-hooks/exhaustive-deps
      if (WindowNavigationState.navigateFunctionRef.current === maybeHandler) {
        WindowNavigationState.navigateFunctionRef.current = Option.none()
      }
      // oxlint-enable eslint-plugin-react-hooks/exhaustive-deps
    }
  }, [navigate])
}

/**
 * Mount under a React Router router. Watches navigation to emit
 * `RouteChanged`, wires the navigate handler to `useNavigate()`, and
 * drains any pre-mount navigation events the receiver layer queued.
 * Renders no DOM.
 */
function NavigationBridgeHandler({
  sender,
}: {
  sender: typeof NavigationBridge.Web.send
}): JSX.Element | null {
  useRouteChangeWatcher(sender)
  useNavigateHandlerUpdater()

  return null
}

export { NavigationBridgeHandler }
