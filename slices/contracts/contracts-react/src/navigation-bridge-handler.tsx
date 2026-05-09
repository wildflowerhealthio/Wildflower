import type { NavigationBridge } from 'contracts-core'
import { Match, Option } from 'effect'
import { type JSX, useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router'
import * as WindowNavigationState from './internal/window-navigation-state'
/**
 * Mutable nav-handle a {@link NavigationBridge} receiver closes over.
 * The embedded-app aggregator builds this before the transport so the
 * `HostBackRequested` / `HostRequestedWebNavigation` handlers can push
 * pending navigations into a shared queue when `current === null`
 * (pre-mount), and route directly through `current(...)` once
 * `<NavigateBinder>` mounts and resolves `useNavigate()`.
 *
 * Lives in `contracts-react` rather than `effect-messaging-react`
 * because the queue is specifically tied to the navigation contract —
 * the bridge schemas and React Router glue are co-located.
 */

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
const useRouteChangeWatcher = (send: NavigationBridge['Web']['SenderType']): void => {
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
    // First, update the global handler ref
    const handler = Match.type<number | string>().pipe(
      // Unpack the cases so React Router's navigate typechecks
      Match.when(Match.number, (to) => void navigate(to)),
      Match.when(Match.string, (to) => void navigate(to)),
      Match.exhaustive
    )

    // oxlint-disable-next-line unicorn/no-array-callback-reference
    const maybeHandler = Option.some(handler)
    WindowNavigationState.navigateFunctionRef.current = maybeHandler

    // Consume all available pendingNavigations
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
 * Mount under a React Router router (e.g. `<MemoryRouter>`). Wires
 * `navRef.current` to `useNavigate()` and drains any pre-mount
 * navigation events the receiver layer's handler accumulated. Renders
 * no DOM.
 *
 * One binder handles both back-requests (`-1`) and path-pushes
 * (string).
 */
function NavigationBridgeHandler({
  sender,
}: {
  sender: NavigationBridge['Web']['SenderType']
}): JSX.Element | null {
  useRouteChangeWatcher(sender)
  useNavigateHandlerUpdater()

  return null
}

export { NavigationBridgeHandler }
