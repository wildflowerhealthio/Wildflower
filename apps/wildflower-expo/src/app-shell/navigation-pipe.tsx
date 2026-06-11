/* oxlint-disable react/only-export-components -- a sender pipe is a
   Provider component paired with its companion `use*` hook; keeping them
   in one module is the whole point of the pattern. */
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import type { NavigationBridge } from 'navigation-core'
import { createContext, useRef, type JSX, type ReactNode, type RefObject } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

type NavigationSender = BridgeTransport.MessageSender<
  readonly [typeof NavigationBridge],
  'HostToWeb'
>

/**
 * App-local navigation pipe: a ref slot holding the shell WebView's
 * `HostToWeb` sender, so the navigation host binding can push host-owned
 * state — `SafeAreaInsetsChanged` and `HostColorSchemeChanged` — into the
 * embedded SPA across reloads.
 *
 *  - `NavigationPipeProvider` mounts the ref slot — wrap the router Stack
 *    with it so the shell screen and its navigation host binding resolve
 *    the same context.
 *  - `useNavigationSenderRef()` returns the ref; the navigation binding's
 *    `onPageReady` writes the WebView transport's `sendMessage` into it on
 *    every page `__Ready`, and the inset / colour-scheme effects read
 *    `.current` to push updates. Before registration the slot holds the
 *    warn-and-drop default.
 *
 * Lives in the app rather than `navigation-expo` because the host-shell
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

export { NavigationPipeProvider, useNavigationSenderRef }
