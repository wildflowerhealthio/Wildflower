import { CollectorBridgeExpo } from 'collector-expo'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { useCallback, useMemo, useRef, type JSX } from 'react'
import { Sentry } from 'telemetry-react-native'
import AppLivestoreProvider from '../components/app-livestore-provider.tsx'
import { AppShellContext } from '../components/app-shell-context.ts'
import type { AppShellWebViewHandle } from '../components/app-shell-webview.tsx'
import { WildflowerDaemons } from '../components/wildflower-daemons.tsx'

/**
 * Root layout. Owns the shell ref so the `index` screen (where the
 * shell mounts) and the `collector-modal` screen (where the sniffer
 * mounts) share one source of truth. The Stack's modal presentation
 * keeps `index` mounted underneath the modal so the shell's WebView
 * never tears down mid-scrape.
 *
 * `AppLivestoreProvider` wraps the stack so any descendant can call
 * `useWildflowerStore()`. `<WildflowerDaemons />` is rendered as a
 * sibling (not a wrapper) — it spawns the on-device HTTP-server +
 * tunnel daemons at first mount and renders nothing. Consumers read
 * daemon state via `useQuery` against the livestore directly.
 *
 * `<CollectorBridgeExpo.HostProvider>` owns the collector slice's
 * `pendingSource` state and the routing-to-modal action; the
 * `postRawMessage` callback we hand it dereferences `shellRef` so
 * sniffer events forward back into the SPA via the host shell's
 * imperative handle.
 */
const RootLayout = Sentry.wrap(function RootLayout(): JSX.Element {
  const shellRef = useRef<AppShellWebViewHandle | null>(null)
  const postRawMessage = useCallback((rawWire: string): void => {
    shellRef.current?.postRawMessage(rawWire)
  }, [])
  const appShellContextValue = useMemo(() => ({ shellRef }), [])

  return (
    <AppLivestoreProvider>
      <WildflowerDaemons />
      <AppShellContext.Provider value={appShellContextValue}>
        <CollectorBridgeExpo.HostProvider postRawMessage={postRawMessage}>
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
      </AppShellContext.Provider>
    </AppLivestoreProvider>
  )
})

export default RootLayout
