import { CollectorBridgeExpo } from 'collector-expo'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { type JSX } from 'react'
import { Sentry } from 'telemetry-react-native'
import AppLivestoreProvider from '../components/app-livestore-provider.tsx'

/**
 * Root layout. The `index` screen owns the shell WebView; the
 * `collector-modal` screen mounts a sniffer WebView whose typed
 * events are re-emitted into the SPA's `CollectorBridge` via
 * `useCollectorHostMessaging` (inside the modal). The Stack's modal
 * presentation keeps `index` mounted underneath the modal so the
 * shell's WebView never tears down mid-scrape.
 *
 * `AppLivestoreProvider` wraps the stack so any descendant can call
 * `useWildflowerStore()`. It also launches the on-device HTTP-server
 * + tunnel daemons under a single `Layer.launch` keyed on the store
 * handle, with `Fiber.interrupt` cleanup on unmount. Consumers read
 * daemon state via `useQuery` against the livestore directly.
 *
 * `<CollectorBridgeExpo.HostProvider>` owns the collector slice's
 * `pendingSource` state and the `snifferControlRef` the modal
 * registers so inbound `Click` / `CancelSnifferRequest` messages from
 * the SPA reach the sniffer page.
 */
const RootLayout = Sentry.wrap(function RootLayout(): JSX.Element {
  return (
    <AppLivestoreProvider>
      <CollectorBridgeExpo.HostProvider>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen
            name="collector-modal"
            options={{ presentation: 'modal', title: 'Run Sync' }}
          />
        </Stack>
        {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar accepts a string `style` */}
        <StatusBar style="auto" />
      </CollectorBridgeExpo.HostProvider>
    </AppLivestoreProvider>
  )
})

export default RootLayout
