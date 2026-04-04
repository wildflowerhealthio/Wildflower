import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'

import { type JSX } from 'react'
import AppLivestoreProvider from '@/components/app-livestore-provider'
import { useColorScheme } from '@/hooks/use-color-scheme'

// oxlint-disable-next-line react/only-export-components
export const unstable_settings = {
  anchor: '(tabs)',
}

export default function RootLayout(): JSX.Element {
  const colorScheme = useColorScheme()

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AppLivestoreProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
          <Stack.Screen
            name="run-sync-modal"
            options={{ presentation: 'modal', title: 'Run Sync' }}
          />
          <Stack.Screen
            name="account-config-modal"
            options={{ presentation: 'modal', title: 'Account Config' }}
          />
        </Stack>
      </AppLivestoreProvider>
      <StatusBar style="auto" />
    </ThemeProvider>
  )
}
