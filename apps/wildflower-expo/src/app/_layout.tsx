import type { WebViewSource } from 'collector-fundamentals/model'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { useRef, useState, type JSX } from 'react'
import { Sentry } from 'telemetry-react-native'
import AppLivestoreProvider from '../components/app-livestore-provider.tsx'
import { AppShellContext } from '../components/app-shell-context.ts'
import type { AppShellWebViewHandle } from '../components/app-shell-webview.tsx'
import { WildflowerDaemons } from '../components/wildflower-daemons.tsx'

/**
 * Root layout. Owns the shell ref + pending sniffer source so the
 * `index` screen (where the shell mounts) and the `run-sync-modal`
 * screen (where the sniffer mounts) share one source of truth.
 * The Stack's modal presentation keeps `index` mounted underneath
 * the modal so the shell's WebView never tears down mid-scrape.
 *
 * `AppLivestoreProvider` wraps the stack so any descendant can call
 * `useWildflowerStore()`. `<WildflowerDaemons />` is rendered as a
 * sibling (not a wrapper) — it spawns the on-device HTTP-server +
 * tunnel daemons at first mount and renders nothing. Consumers read
 * daemon state via `useQuery` against the livestore directly.
 */
const RootLayout = Sentry.wrap(function RootLayout(): JSX.Element {
  const shellRef = useRef<AppShellWebViewHandle | null>(null)
  const [pendingSource, setPendingSource] = useState<WebViewSource.Any | null>(null)

  return (
    <AppLivestoreProvider>
      <WildflowerDaemons />
      <AppShellContext.Provider value={{ shellRef, pendingSource, setPendingSource }}>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen
            name="run-sync-modal"
            options={{ presentation: 'modal', title: 'Run Sync' }}
          />
        </Stack>
        {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar accepts a string `style` */}
        <StatusBar style="auto" />
      </AppShellContext.Provider>
    </AppLivestoreProvider>
  )
})

export default RootLayout
