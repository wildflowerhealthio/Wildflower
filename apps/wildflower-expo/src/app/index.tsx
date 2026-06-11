import { ThemedView } from 'expo-tundraish'
import { type JSX } from 'react'
import { StyleSheet, View } from 'react-native'

import { AppShellWebView } from '../app-shell/app-shell-webview.tsx'

// Splash is suppressed by `side-effect-imports/prevent-splash-hide.ts`
// (side-effect import in `index.ts`, before `expo-router/entry`).
// Here we only own the `hideAsync` reveal once the WebView is alive.

/**
 * The persistent shell screen — mounts the full-bleed `<AppShellWebView>`.
 *
 * Top-level navigation now lives inside the embedded SPA (the web tab bar
 * in `wildflower-react`), so the host no longer paints a native tab bar
 * and no longer tracks route changes; the WebView fills the whole screen.
 */
export default function HomeScreen(): JSX.Element {
  return (
    <ThemedView style={styles.fill}>
      <View style={styles.webViewWrap}>
        <AppShellWebView />
      </View>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  webViewWrap: {
    flex: 1,
  },
})
