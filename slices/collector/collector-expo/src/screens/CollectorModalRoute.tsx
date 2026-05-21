import { useRouter } from 'expo-router'
import { ThemedText, ThemedView } from 'expo-tundraish'
import { type JSX } from 'react'
import { StyleSheet } from 'react-native'
import { useHost } from '../host-receiver-layer.tsx'
import { CollectorModalScreen } from './CollectorModalScreen.tsx'

/**
 * Default-export route component that hosts {@link CollectorModalScreen}
 * (a `BrowserSnifferWebView` wrapper) and threads the
 * `postRawMessage` handle from `<CollectorBridgeExpo.HostProvider>`
 * so sniffer events round-trip back into the embedded SPA's
 * `CollectorBridge`. The host shell underneath stays mounted (Stack
 * `presentation: 'modal'`); its WebView never tears down mid-scrape.
 *
 * Consumers register this in their expo-router file system by
 * re-exporting it as the default from a route file at the path
 * passed to `<HostProvider modalPath="…">` (default `/collector-modal`):
 *
 * ```ts
 * // apps/<your-app>/src/app/collector-modal.tsx
 * export { CollectorModalRoute as default } from 'collector-expo'
 * ```
 */
const CollectorModalRoute = (): JSX.Element => {
  const { pendingSource, postRawMessage } = useHost()
  const router = useRouter()

  if (pendingSource === null) {
    // Defensive — the route should only ever be pushed after the
    // receiver layer's `RequestSniffableWebView` handler set
    // `pendingSource`. Surface the inconsistency rather than render
    // a broken `BrowserSnifferWebView`.
    return (
      <ThemedView style={styles.empty}>
        <ThemedText type="heading3">No sniffer source</ThemedText>
        <ThemedText>The host shell pushed this modal without queuing a sniffer source.</ThemedText>
        <ThemedText type="link" onPress={() => router.back()}>
          Close
        </ThemedText>
      </ThemedView>
    )
  }

  return <CollectorModalScreen source={pendingSource} postRawMessage={postRawMessage} />
}

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
})

export { CollectorModalRoute }
