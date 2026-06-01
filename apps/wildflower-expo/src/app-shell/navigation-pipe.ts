import { makeNamedPipe } from 'effect-messaging-react'
import { NavigationBridge } from 'navigation-core'

/**
 * App-local navigation pipe: lets the native tab bar (sibling of the
 * shell WebView) dispatch typed `HostRequestedWebNavigation` /
 * `HostBackRequested` messages through whatever sender the shell
 * registers — in production, the WebView transport's `sendMessage`
 * captured by the navigation binding's `onTransportReady`.
 *
 * Mirrors the collector slice's pipe pattern
 * (`slices/collector/collector-expo/src/message-sender-pipes.tsx`):
 *
 *  - `NavigationPipeProvider` mounts the ref slot — wrap the router
 *    Stack with it so both the shell screen (which calls
 *    `useAsNavigationOutlet`) and the tab bar (which calls
 *    `useNavigationSender`) resolve to the same context.
 *  - `useAsNavigationOutlet(sender)` registers the active sender;
 *    pre-mount / pre-transport sends route through the pipe's
 *    warn-and-drop default until a real sender is installed.
 *  - `useNavigationSender()` returns the typed sender for descendants
 *    to call.
 *
 * Lives in the app rather than `navigation-expo` because the
 * sibling-tab-bar layout is wildflower-specific and host-shell
 * dispatchers are wildflower-shaped (the four-bridge tuple).
 */
const {
  Provider: NavigationPipeProvider,
  useSenderRef: useNavigationSenderRef,
  useAsOutlet: useAsNavigationOutlet,
  useSender: useNavigationSender,
} = makeNamedPipe('WildflowerNavigation', [NavigationBridge] as const, 'HostToWeb')

export {
  NavigationPipeProvider,
  useAsNavigationOutlet,
  useNavigationSender,
  useNavigationSenderRef,
}
