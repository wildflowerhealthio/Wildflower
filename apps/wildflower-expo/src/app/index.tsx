import { ThemedView } from 'expo-tundraish'
import { useCallback, type JSX } from 'react'
import { StyleSheet, View } from 'react-native'

import { AppShellWebView } from '../app-shell/app-shell-webview.tsx'

// Splash is suppressed by `side-effect-imports/prevent-splash-hide.ts`
// (side-effect import in `index.ts`, before `expo-router/entry`).
// Here we only own the `hideAsync` reveal once the WebView is alive.

/**
 * The persistent shell screen — mounts the full-bleed `<AppShellWebView>`.
 *
 * Top-level navigation now lives inside the embedded SPA (the web tab bar
 * in `wildflower-react`), so the host no longer paints a native tab bar;
 * the WebView fills the whole screen.
 */
export default function HomeScreen(): JSX.Element {
  // The navigation binding requires a `RouteChanged` sink. Nothing on the
  // host consumes route changes now that the native tab bar's active-tab
  // tracking is gone, so swallow them.
  const handleRouteChanged = useCallback((): void => {}, [])

  return (
    <ThemedView style={styles.fill}>
      <View style={styles.webViewWrap}>
        <AppShellWebView onRouteChanged={handleRouteChanged} />
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
