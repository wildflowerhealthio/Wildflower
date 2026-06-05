import { Spacing, ThemedButton, ThemedText, ThemedView } from 'expo-tundraish'
import { type JSX } from 'react'
import { StyleSheet } from 'react-native'

interface DevServerUnreachableProps {
  /** The `EXPO_PUBLIC_DEV_SPA_URL` the WebView failed to load. */
  readonly devSpaUrl: string
  /** react-native-webview's `nativeEvent.description` for the load failure. */
  readonly description: string
  /** Remount the WebView and retry the load. */
  readonly onRetry: () => void
}

/**
 * Full-screen, dev-only fallback shown when the WebView fails to load the
 * remote dev SPA (`EXPO_PUBLIC_DEV_SPA_URL`). Fails loudly on purpose: a
 * silent native error page or a blank WebView would look like an app bug,
 * when the real cause is almost always a dev server that isn't running or
 * isn't reachable from the device. Only reachable in `__DEV__` builds that
 * opted into the dev-SPA URL; the shipped app always loads the embedded
 * bundle and never mounts this.
 */
const DevServerUnreachable = ({
  devSpaUrl,
  description,
  onRetry,
}: DevServerUnreachableProps): JSX.Element => (
  <ThemedView style={styles.container}>
    <ThemedText type="heading2" style={styles.line}>
      Dev SPA server unreachable
    </ThemedText>
    <ThemedText type="body" style={styles.line}>
      Could not load the wildflower-react dev server at:
    </ThemedText>
    <ThemedText type="mono" style={styles.line}>
      {devSpaUrl}
    </ThemedText>
    <ThemedText type="body" style={styles.line}>
      Start it with `vp run dev --host` (the `--host` flag exposes it on your LAN so the device can
      reach it), then confirm `EXPO_PUBLIC_DEV_SPA_URL` points at the printed URL.
    </ThemedText>
    <ThemedText type="label" style={styles.line}>
      {description}
    </ThemedText>
    <ThemedButton title="Retry" onPress={onRetry} />
  </ThemedView>
)

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.s5,
    gap: Spacing.s4,
  },
  line: {
    textAlign: 'center',
  },
})

export { DevServerUnreachable }
export type { DevServerUnreachableProps }
