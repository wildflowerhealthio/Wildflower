import { CollectorHostProvider } from 'collector-expo'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { type JSX } from 'react'
import { Sentry } from 'telemetry-react-native'

import AppRuntimeProvider from '../components/app-runtime-provider.tsx'
import { NavigationPipeProvider } from '../components/navigation-pipe.ts'

/**
 * Root layout. Stacks the runtime, collector host, and navigation pipe
 * above the file-system router. The Stack's modal presentation keeps
 * `index` mounted underneath the `collector-modal` route so the shell's
 * WebView never tears down mid-scrape. `<NavigationPipeProvider>` sits
 * above the Stack so a future modal route resolves the same pipe; its
 * pipe contract lives in {@link NavigationPipeProvider}'s file-header.
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
          {/* oxlint-disable-next-line react/style-prop-object --
             this is `expo-status-bar`'s `StatusBar`, not React Native's;
             its `style` is a `StatusBarStyle` string union
             (`"auto" | "inverted" | "light" | "dark"`), not RN's
             `ViewStyle`. The rule's heuristic flags any string `style`
             prop as suspicious. */}
          <StatusBar style="auto" />
        </NavigationPipeProvider>
      </CollectorHostProvider>
    </AppRuntimeProvider>
  )
})

export default RootLayout
