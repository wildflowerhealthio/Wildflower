import { NavigationBridge } from 'contracts-core'
import { Effect, Option } from 'effect'
import * as NavigationState from './internal/window-navigation-state'
import type { NavTarget } from './internal/window-navigation-state'

const enqueueNavigate = (target: NavTarget): void => {
  const maybeNavigateFunction = NavigationState.navigateFunctionRef.current
  Option.match(maybeNavigateFunction, {
    onSome: (navigate) => navigate(target),
    onNone: () => NavigationState.pendingNavigations.push(target),
  })
}

const navigationWebReceiverLayer = NavigationBridge.Web.ReceiverLayer({
  HostBackRequested: () => Effect.sync(() => enqueueNavigate(-1)),
  HostRequestedWebNavigation: ({ path }) => Effect.sync(() => enqueueNavigate(path)),
})

export { navigationWebReceiverLayer }
