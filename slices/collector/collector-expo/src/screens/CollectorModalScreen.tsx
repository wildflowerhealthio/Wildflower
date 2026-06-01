import {
  BrowserSnifferWebView,
  type BrowserSnifferMessageSender,
  type SnifferHandlers,
} from 'browser-sniffer-expo'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import { Spacing, ThemedView } from 'expo-tundraish'
import { useMemo, type JSX } from 'react'
import { useFunctionSafeState } from 'react-kitchen-sink'
import { StyleSheet } from 'react-native'

import { useAsBrowserSnifferOutlet, useCollectorSender } from '../message-sender-pipes.tsx'
import { toLoadFrom } from './to-load-from.ts'

interface CollectorModalScreenProps {
  /**
   * Page the sniffer should load — the bridge-tagged
   * `WebViewSource.Any` the SPA emits in `RequestSniffableWebView` /
   * `Open`. Converted to `BrowserSnifferWebView`'s lowercase-tag
   * `BridgedWebViewLoadFrom` shape by {@link toLoadFrom}.
   */
  readonly source: WebViewSource.Any
  /**
   * Optional error sink for non-decode failures the bridge would
   * otherwise log. Receives the decoded `RequestError` event verbatim.
   */
  readonly onError?: (error: { id: string; url: string; message: string }) => void
}

/**
 * Logged when a sniffer message is dispatched before the modal's
 * `<BrowserSnifferWebView>` ref has populated its typed sender. Logs
 * only `msg._tag` to bound the message size — a full `JSON.stringify`
 * on a `ResponseData` payload can be megabytes.
 */
const fallbackWarningSnifferSender: BrowserSnifferMessageSender = (msg) =>
  Effect.logWarning(`[CollectorModalScreen] sniffer not yet mounted; dropping ${msg._tag}`)

/**
 * Native modal that hosts a `<BrowserSnifferWebView>` for an
 * "Import Now" flow. Forwards decoded sniffer events through the
 * Collector pipe so the embedded SPA's bridge dispatches them, and
 * registers the WebView's typed sender through the BrowserSniffer
 * pipe so the handler record's `Click` / `CancelSnifferRequest`
 * handlers can drive the sniffer page.
 */
const CollectorModalScreen = ({ source, onError }: CollectorModalScreenProps): JSX.Element => {
  // `BrowserSnifferWebView`'s ref imperative value is itself a
  // function; `useFunctionSafeState` stores it without React treating
  // it as a state updater.
  const [snifferSender, setSnifferSender] =
    useFunctionSafeState<BrowserSnifferMessageSender | null>(null)
  useAsBrowserSnifferOutlet(snifferSender ?? fallbackWarningSnifferSender)

  const sendToCollector = useCollectorSender()

  const handlers = useMemo<SnifferHandlers>(
    () => ({
      ResponseStart: sendToCollector,
      ResponseData: sendToCollector,
      ResponseFinished: sendToCollector,
      Cancelled: sendToCollector,
      PageLoaded: sendToCollector,
      RequestError: (event) =>
        sendToCollector(event).pipe(
          // Forward-then-observe: `Effect.tap` runs `onError` *after*
          // the dispatch resolves. `catchAllCause` is deliberate
          // fiber-isolation (an `onError` throw should not interrupt
          // the dispatch fiber) — not error-suppression.
          Effect.tap(() =>
            Effect.sync(() => onError?.(event)).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError('CollectorModalScreen: onError callback failed', cause)
              )
            )
          )
        ),
    }),
    [onError, sendToCollector]
  )

  const loadFrom = useMemo(() => toLoadFrom(source), [source])

  return (
    <ThemedView style={styles.container}>
      <BrowserSnifferWebView
        ref={setSnifferSender}
        loadFrom={loadFrom}
        browserSnifferHandlers={handlers}
      />
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.s5,
  },
})

export { CollectorModalScreen }
export type { CollectorModalScreenProps }
