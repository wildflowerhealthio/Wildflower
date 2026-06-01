import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import type { NavigationBridge } from 'navigation-core'

/** Navigation target: `-1` is the back-step sentinel; a string is a path push. */
type NavTarget = -1 | string

/**
 * Build the Web-side inbound handler record for {@link NavigationBridge},
 * closing handlers over the supplied `navigate` function. Call this
 * inside a React component that has access to `useNavigate()` (or a
 * stable proxy that delegates to the latest `useNavigate` result),
 * then hand the resulting record to `BridgeTransport.make`'s `handlers`.
 *
 * @remarks
 * The previous implementation buffered targets in a module-level array
 * because handlers could fire before `useNavigate()` was wired. The
 * transport now parks inbound messages whose tag has no handler yet and
 * replays them in arrival order once `registerHandlers` installs a
 * covering handler, so a `navigate` is always present by dispatch time.
 */
const makeNavigationWebHandlers = (
  navigate: (target: NavTarget) => void
): Bridge.HalfHandlers<(typeof NavigationBridge)['Web']> => ({
  HostBackRequested: () => Effect.sync(() => navigate(-1)),
  HostRequestedWebNavigation: ({ path }) => Effect.sync(() => navigate(path)),
})

export { makeNavigationWebHandlers }
export type { NavTarget }
