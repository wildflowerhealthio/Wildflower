import {
  BrowserSnifferWebView,
  type BrowserSnifferWebViewHandle,
  type SnifferHandlers,
} from 'browser-sniffer-expo'
import { Effect } from 'effect'
import type { ExpoTransport } from 'effect-messaging-expo'
import { Spacing, ThemedView } from 'expo-tundraish'
import { useMemo, useRef, type JSX } from 'react'
import { StyleSheet } from 'react-native'

import type { Bridges } from '../components/CollectorWebView.tsx'

interface RunSyncModalScreenProps {
  /**
   * Page the sniffer should load. Mirrors the `source` payload the SPA
   * sends in `RequestSniffableWebView`.
   */
  readonly source: { uri: string } | { html: string; baseUrl?: string }
  /**
   * The active CollectorWebView's `sendCollectorMessage`. Used to
   * forward the five collector-relevant sniffer events
   * (`ResponseStart` / `ResponseData` / `ResponseFinished` /
   * `RequestError` / `Cancelled`) back through CollectorBridge so the
   * SPA's sync runner can parse them and close out in-flight slots.
   *
   * Wire-schema compatibility: both bridges import the same event
   * schemas from `browser-sniffer-core`, so the forwarded message
   * round-trips without re-encoding.
   */
  readonly sendCollectorMessage: ExpoTransport<Bridges>['sendMessage']
  /** Optional error sink for non-decode failures the bridge would otherwise log. */
  readonly onError?: (error: { id: string; url: string; message: string }) => void
}

/**
 * Native modal that hosts a `<BrowserSnifferWebView>` for an "Import
 * Now" flow. The CollectorWebView under the modal stays mounted; this
 * screen just captures sniffer events from the page being scraped and
 * forwards them through the host's CollectorBridge transport so the
 * embedded SPA's sync runner sees them live.
 */
const RunSyncModalScreen = ({
  source,
  sendCollectorMessage,
  onError,
}: RunSyncModalScreenProps): JSX.Element => {
  const snifferRef = useRef<BrowserSnifferWebViewHandle>(null)

  // Build the bridge handlers once per `sendCollectorMessage` identity.
  // Each forward dispatches an Effect that the bridge transport drains.
  const handlers = useMemo<SnifferHandlers>(
    () => ({
      Log: () => Effect.void,
      ResponseStart: (event) => sendCollectorMessage(event),
      ResponseData: (event) => sendCollectorMessage(event),
      ResponseFinished: (event) => sendCollectorMessage(event),
      RequestError: (event) =>
        Effect.sync(() => {
          onError?.(event)
          void Effect.runPromise(sendCollectorMessage(event))
        }),
      Cancelled: (event) => sendCollectorMessage(event),
      PageLoaded: () => Effect.void,
    }),
    [sendCollectorMessage, onError]
  )

  return (
    <ThemedView style={styles.container}>
      <BrowserSnifferWebView ref={snifferRef} source={source} handlers={handlers} />
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.s5,
  },
})

export { RunSyncModalScreen }
export type { RunSyncModalScreenProps }
