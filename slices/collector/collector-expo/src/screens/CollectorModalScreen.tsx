import {
  BrowserSnifferWebView,
  type BrowserSnifferMessageSender,
  type SnifferHandlers,
} from 'browser-sniffer-expo'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import type { BridgedWebViewLoadFrom } from 'effect-messaging-expo'
import { Spacing, ThemedView } from 'expo-tundraish'
import { useCallback, useMemo, useState, type JSX } from 'react'
import { StyleSheet } from 'react-native'

import {
  useAsMessageSenderToBrowserSniffer,
  useMessageSenderToCollector,
} from '../message-sender-pipes.tsx'

interface CollectorModalScreenProps {
  /**
   * Page the sniffer should load — the bridge-tagged
   * `WebViewSource.Any` the SPA emits in `RequestSniffableWebView`
   * (or subsequent `Open` messages). The collector-fundamentals
   * tagged-union encoding (`{_tag: 'Uri' | 'Html', ...}`) is
   * converted at the boundary to `BrowserSnifferWebView`'s
   * lowercase-tag {@link BridgedWebViewLoadFrom} shape.
   */
  readonly source: WebViewSource.Any
  /**
   * Optional error sink for non-decode failures the bridge would
   * otherwise log. Receives the decoded `RequestError` event verbatim.
   */
  readonly onError?: (error: { id: string; url: string; message: string }) => void
}

const FALLBACK_BASE_URL = 'about:blank' as const

/**
 * Convert the collector slice's internal `WebViewSource.Any` tagged
 * union (`{_tag: 'Uri', uri}` / `{_tag: 'Html', html, baseUrl?}`) to
 * `BrowserSnifferWebView`'s {@link BridgedWebViewLoadFrom} shape
 * (`{_tag: 'uri', uri}` / `{_tag: 'html', html, baseUrl}`). The
 * collector schema makes `baseUrl` optional on `Html`; the
 * `BridgedWebView` shape requires it (used as the origin the
 * transport's `initialMessages` are appended to). Falling back to
 * `about:blank` keeps the WebView mountable when callers don't set
 * an origin — relative URLs in the html source won't resolve, but
 * the page renders.
 */
const toLoadFrom = (source: WebViewSource.Any): BridgedWebViewLoadFrom =>
  source._tag === 'Uri'
    ? { _tag: 'uri', uri: source.uri }
    : { _tag: 'html', html: source.html, baseUrl: source.baseUrl ?? FALLBACK_BASE_URL }

/**
 * Native modal that hosts a `<BrowserSnifferWebView>` for an
 * "Import Now" flow. The host shell's persistent WebView stays
 * mounted under the modal; this screen forwards decoded sniffer
 * events through `useMessageSenderToCollector` into the embedded
 * SPA's bridge. Because the six passthrough schemas are imported
 * verbatim from `browser-sniffer-core` on both sides, the decoded
 * value passes through without conversion.
 *
 * `Click` / `CancelSnifferRequest` flow the opposite direction: the
 * sniffer's typed `BridgeTransport.MessageSender` (exposed via
 * `BrowserSnifferWebView`'s ref) is registered into the
 * BrowserSniffer pipe via `useAsMessageSenderToBrowserSniffer` so
 * the collector receiver layer can drive the sniffer page. Stored
 * in component state so a late-arriving ref triggers the pipe's
 * `useEffect` re-run.
 *
 * The screen is intentionally stateless beyond `snifferSender` —
 * source re-mounts on `Open` are driven by the host context's
 * `pendingSource` (changed by the receiver layer's `Open` handler),
 * which propagates through {@link CollectorModalRoute}'s read of
 * `useHost()`.
 */
const CollectorModalScreen = ({ source, onError }: CollectorModalScreenProps): JSX.Element => {
  const [snifferSender, setSnifferSender] = useState<BrowserSnifferMessageSender | null>(null)
  // `BrowserSnifferWebView`'s ref imperative value is itself a
  // function. `setState(fn)` would treat that as an updater; the
  // updater-form wrap stores the function value as state instead.
  const captureSnifferSender = useCallback(
    (sender: BrowserSnifferMessageSender | null): void => {
      setSnifferSender(() => sender)
    },
    []
  )
  useAsMessageSenderToBrowserSniffer(snifferSender ?? noopBrowserSnifferSender)

  const sendToCollector = useMessageSenderToCollector()

  const handlers = useMemo<SnifferHandlers>(
    () => ({
      ResponseStart: (event) => sendToCollector(event),
      ResponseData: (event) => sendToCollector(event),
      ResponseFinished: (event) => sendToCollector(event),
      Cancelled: (event) => sendToCollector(event),
      PageLoaded: (event) => sendToCollector(event),
      RequestError: (event) =>
        Effect.sync(() => onError?.(event)).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('CollectorModalScreen: onError callback failed', cause)
          ),
          Effect.zipRight(sendToCollector(event))
        ),
    }),
    [onError, sendToCollector]
  )

  const loadFrom = useMemo(() => toLoadFrom(source), [source])

  return (
    <ThemedView style={styles.container}>
      <BrowserSnifferWebView
        ref={captureSnifferSender}
        loadFrom={loadFrom}
        browserSnifferHandlers={handlers}
      />
    </ThemedView>
  )
}

const noopBrowserSnifferSender: BrowserSnifferMessageSender = (msg) =>
  Effect.logWarning(
    `[CollectorModalScreen] sniffer not yet mounted; dropping ${JSON.stringify(msg)}`
  )

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.s5,
  },
})

export { CollectorModalScreen }
export type { CollectorModalScreenProps }
