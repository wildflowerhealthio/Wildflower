/* oxlint-disable react/only-export-components -- a sender pipe is a
   Provider component paired with its companion `use*` hooks; keeping them
   in one module is the whole point of the pattern. */
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { useLateBoundSender } from 'effect-messaging-react'
import type { NavigationBridge } from 'navigation-core'
import { createContext, useRef, type JSX, type ReactNode, type RefObject } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

type NavigationSender = BridgeTransport.MessageSender<
  readonly [typeof NavigationBridge],
  'HostToWeb'
>

/**
 * App-local navigation pipe: lets the native tab bar (sibling of the
 * shell WebView) dispatch typed `HostRequestedWebNavigation` /
 * `HostBackRequested` messages through whatever sender the shell
 * registers — in production, the WebView transport's `sendMessage`,
 * written into the sender ref from the navigation binding's
 * `onTransportReady`.
 *
 *  - `NavigationPipeProvider` mounts the ref slot — wrap the router Stack
 *    with it so both the shell screen (which writes the sender ref via
 *    {@link useNavigationSenderRef} on `onTransportReady`) and the tab bar
 *    (which calls {@link useNavigationSender}) resolve to the same context.
 *  - `useNavigationSender()` returns the typed sender for descendants to
 *    call; pre-registration sends route through the warn-and-drop default.
 *
 * Lives in the app rather than `navigation-expo` because the
 * sibling-tab-bar layout is wildflower-specific and host-shell
 * dispatchers are wildflower-shaped (the four-bridge tuple).
 */
const navigationWarnAndDrop: NavigationSender = (msg) =>
  Effect.logWarning(
    `[effect-messaging] no WildflowerNavigation sender registered; dropping message "${JSON.stringify(msg)}"`
  )

const NavigationSenderContext = createContext<RefObject<NavigationSender> | null>(null)
NavigationSenderContext.displayName = 'NavigationSenderContext'

const NavigationPipeProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const ref = useRef<NavigationSender>(navigationWarnAndDrop)

  return <NavigationSenderContext.Provider value={ref}>{children}</NavigationSenderContext.Provider>
}

const useNavigationSenderRef = (): RefObject<NavigationSender> =>
  useContextOrThrow(NavigationSenderContext)

const useNavigationSender = (): NavigationSender => useLateBoundSender(useNavigationSenderRef())

export { NavigationPipeProvider, useNavigationSender, useNavigationSenderRef }
