import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'

/** Navigation target: `-1` is the back-step sentinel; a string is a path push. */
type NavTarget = -1 | string

/**
 * Build the Web-side `ReceiverLayer` for {@link NavigationBridge},
 * closing handlers over the supplied `navigate` function. Call this
 * inside a React component that has access to `useNavigate()` (or a
 * stable proxy that delegates to the latest `useNavigate` result),
 * then hand the resulting Layer to `BridgeTransport.make`.
 *
 * @remarks
 * The previous implementation buffered targets in a module-level array
 * because handlers could fire before `useNavigate()` was wired. With
 * the new transport handshake (`__Ready` is the first thing the web
 * sends, posted *after* receivers are mounted), there is no pre-mount
 * window — handlers always have a `navigate` to call.
 */
const makeNavigationWebReceiverLayer = (
  navigate: (target: NavTarget) => void
): Layer.Layer<MessageHandler.TagId<'Navigation', 'Web'>> =>
  NavigationBridge.Web.ReceiverLayer({
    HostBackRequested: () => Effect.sync(() => navigate(-1)),
    HostRequestedWebNavigation: ({ path }) => Effect.sync(() => navigate(path)),
  })

export { makeNavigationWebReceiverLayer }
export type { NavTarget }
