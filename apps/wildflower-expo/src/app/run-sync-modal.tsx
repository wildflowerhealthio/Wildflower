import { RunSyncModalScreen } from 'collector-expo'
import { useRouter } from 'expo-router'
import { ThemedText, ThemedView } from 'expo-tundraish'
import { useCallback, useContext, type JSX } from 'react'
import { StyleSheet } from 'react-native'
import { AppShellContext } from '../components/app-shell-context.ts'

/**
 * Modal route. Hosts the `<RunSyncModalScreen>` from `collector-expo`
 * (a `BrowserSnifferWebView` wrapper) and threads the host shell's
 * `postRawMessage` handle through so sniffer events round-
 * trip back into the SPA's `CollectorBridge`. The shell underneath
 * stays mounted (Stack `presentation: 'modal'`); its WebView never
 * tears down mid-scrape.
 */
export default function RunSyncModalRoute(): JSX.Element {
  const ctx = useContext(AppShellContext)
  if (ctx === null) throw new Error('AppShellContext missing — render under <RootLayout>')
  const { shellRef, pendingSource } = ctx
  const router = useRouter()

  const postRawMessage = useCallback(
    (rawWire: string): void => {
      shellRef.current?.postRawMessage(rawWire)
    },
    [shellRef]
  )

  if (pendingSource === null) {
    // Defensive — the route should only ever be pushed after the shell
    // sets pendingSource. Surface the inconsistency rather than render
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

  return <RunSyncModalScreen source={pendingSource} postRawMessage={postRawMessage} />
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
