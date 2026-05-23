import AppsBridge from 'apps-core/bridge'
import { CollectorBridgeExpo } from 'collector-expo'
import CollectorBridge from 'collector-fundamentals/bridge'
import { HoistedHostMessagingProvider } from 'effect-messaging-react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'navigation-core'
import 'react-native-reanimated'
import { type JSX } from 'react'
import { Sentry } from 'telemetry-react-native'
import AppRuntimeProvider from '../components/app-runtime-provider.tsx'

/**
 * Bridges every Stack screen needs host-messaging access to. Must
 * mirror the tuple passed into `<AppShellWebView>`'s bindings, since
 * its `BridgedWebView` registers its `transport.sendMessage` into the
 * ref slot owned by `<HoistedHostMessagingProvider>` below — and
 * `useXxxHostMessaging` hooks fail fast if their bridge isn't listed.
 *
 * Module constant so both screens (the index shell WebView and the
 * collector-modal route) resolve the same bridge tuple.
 */
const BRIDGES = [NavigationBridge, GatekeeperBridge, CollectorBridge, AppsBridge] as const

/**
 * Root layout. The `index` screen owns the shell WebView; the
 * `collector-modal` screen mounts a sniffer WebView whose typed
 * events are re-emitted into the SPA's `CollectorBridge` via
 * `useCollectorHostMessaging` (inside the modal). The Stack's modal
 * presentation keeps `index` mounted underneath the modal so the
 * shell's WebView never tears down mid-scrape.
 *
 * `AppRuntimeProvider` wraps the stack so any descendant can call
 * `useWildflowerStore()`. It also launches the on-device HTTP-server
 * + tunnel daemons under a single `Layer.launch` keyed on the store
 * handle, with `Fiber.interrupt` cleanup on unmount. Consumers read
 * daemon state via `useQuery` against the livestore directly.
 *
 * `<CollectorBridgeExpo.HostProvider>` owns the collector slice's
 * `pendingSource` state and the `snifferControlRef` the modal
 * registers so inbound `Click` / `CancelSnifferRequest` messages from
 * the SPA reach the sniffer page.
 *
 * `<HoistedHostMessagingProvider>` makes the SPA-shell WebView's
 * `transport.sendMessage` reachable from sibling Stack screens (the
 * `collector-modal` route in particular) by way of a ref slot the
 * `BridgedWebView` inside `<AppShellWebView>` registers itself into
 * once its transport finishes building. The inner
 * `<HostMessagingProvider>` `BridgedWebView` still mounts shadows
 * this one for descendants of the index screen — same transport,
 * same sender, just resolved through a closer ancestor.
 */
const RootLayout = Sentry.wrap(function RootLayout(): JSX.Element {
  return (
    <AppRuntimeProvider>
      <CollectorBridgeExpo.HostProvider>
        <HoistedHostMessagingProvider bridges={BRIDGES}>
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen
              name="collector-modal"
              options={{ presentation: 'modal', title: 'Run Sync' }}
            />
          </Stack>
          {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar accepts a string `style` */}
          <StatusBar style="auto" />
        </HoistedHostMessagingProvider>
      </CollectorBridgeExpo.HostProvider>
    </AppRuntimeProvider>
  )
})

export default RootLayout
