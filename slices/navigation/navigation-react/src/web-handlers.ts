import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { NavigationBridge } from 'navigation-core'

/** Navigation target: `-1` is the back-step sentinel; a string is a path push. */
type NavTarget = -1 | string

/**
 * Build the Web-side inbound handler record for {@link NavigationBridge},
 * closing handlers over the supplied `navigate` function. Call this
 * inside a React component that has access to `useNavigate()` (or a
 * stable proxy that delegates to the latest `useNavigate` result),
 * then hand the resulting record to `BridgeTransport.makeWebTransport`'s `handlers`.
 *
 * @remarks
 * The previous implementation buffered targets in a module-level array
 * because handlers could fire before `useNavigate()` was wired. Passing a
 * stable proxy that always delegates to the latest `useNavigate` lets the
 * handler register up front and resolve the current target at dispatch
 * time, so the buffer (and its replay) is gone. A navigation message that
 * does somehow arrive before the handler is registered is dropped by the
 * transport, not queued.
 */
const makeNavigationWebHandlers = (
  navigate: (target: NavTarget) => void
): MessageHandler.HandlersFor<(typeof NavigationBridge)['HostToWeb']> => ({
  HostBackRequested: () => Effect.sync(() => navigate(-1)),
  HostRequestedWebNavigation: ({ path }) => Effect.sync(() => navigate(path)),
})

export { makeNavigationWebHandlers }
export type { NavTarget }
