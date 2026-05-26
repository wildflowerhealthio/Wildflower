import { CollectorHostProvider } from 'collector-expo'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { type JSX } from 'react'
import { Sentry } from 'telemetry-react-native'

import AppRuntimeProvider from '../components/app-runtime-provider.tsx'
import { NavigationPipeProvider } from '../components/navigation-pipe.ts'

/**
 * Root layout.
 *
 * The `index` screen owns the shell `<BridgedWebView>`; the
 * `collector-modal` screen mounts a sniffer WebView whose typed
 * events the collector slice's pipes re-emit into the SPA's
 * `CollectorBridge`. The Stack's modal presentation keeps `index`
 * mounted underneath the modal so the shell's WebView never tears
 * down mid-scrape.
 *
 * `<AppRuntimeProvider>` wraps the stack so any descendant can call
 * `useWildflowerStore()`. It also launches the on-device HTTP-server
 * + tunnel daemons under one `Layer.launch` keyed on the store
 * handle, with `Fiber.interrupt` cleanup on unmount.
 *
 * `<CollectorHostProvider>` owns the collector slice's
 * `pendingSource` state and mounts the `BrowserSnifferPipeProvider`
 * + `CollectorPipeProvider` pair the modal route and the shell
 * binding read from. See its TSDoc for the modal-path contract — we
 * use the default (`/collector-modal`).
 *
 * `<NavigationPipeProvider>` is the wildflower-local pipe that lets
 * the native tab bar inside `index` dispatch typed
 * `HostRequestedWebNavigation` messages through the shell's
 * `<BridgedWebView>` transport. `<AppShellWebView>` plugs the
 * transport's sender into this pipe via `useAsNavigationSource`
 * inside its `onTransportReady`; the tab bar reads it via
 * `useNavigationSender`. Has to sit above the Stack so the modal
 * route also resolves the same pipe (currently unused there, but
 * keeps the provider topology uniform if a future modal grows a
 * tab-bar of its own).
 */
const RootLayout = Sentry.wrap(function RootLayout(): JSX.Element {
  return (
    <AppRuntimeProvider>
      <CollectorHostProvider>
        <NavigationPipeProvider>
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen
              name="collector-modal"
              options={{ presentation: 'modal', title: 'Run Sync' }}
            />
          </Stack>
          {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar accepts a string `style` */}
          <StatusBar style="auto" />
        </NavigationPipeProvider>
      </CollectorHostProvider>
    </AppRuntimeProvider>
  )
})

export default RootLayout
