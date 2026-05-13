import {
  BrowserSnifferWebView,
  type BrowserSnifferWebViewHandle,
  type SnifferHandlers,
} from 'browser-sniffer-expo'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import type { ExpoTransport } from 'effect-messaging-expo'
import { Spacing, ThemedView } from 'expo-tundraish'
import { useImperativeHandle, useMemo, useRef, useState, type JSX, type Ref } from 'react'
import { StyleSheet } from 'react-native'

import type { Bridges } from '../components/CollectorWebView.tsx'

/**
 * Imperative handle exposed via `ref`. The CollectorWebView's
 * `onOpen` / `onClick` callbacks are wired in the parent screen and
 * call into this handle so the active modal can advance its own
 * BrowserSnifferWebView in response to scripted navigation steps.
 */
interface RunSyncModalScreenHandle {
  readonly navigate: (source: WebViewSource.Any) => void
  readonly click: (querySelector: string) => void
}

interface RunSyncModalScreenProps {
  /**
   * Initial page the sniffer should load — the bridge-tagged
   * `WebViewSource.Any` the SPA emits in `RequestSniffableWebView`.
   * The screen mirrors this into local state so subsequent `Open`
   * messages from the SPA can re-mount the sniffer at a fresh URL
   * without remounting the modal.
   */
  readonly source: WebViewSource.Any
  /**
   * The active CollectorWebView's `sendCollectorMessage`. Used to
   * forward the six collector-relevant sniffer events
   * (`ResponseStart` / `ResponseData` / `ResponseFinished` /
   * `RequestError` / `Cancelled` / `PageLoaded`) back through
   * CollectorBridge so the SPA's sync runner can parse them and close
   * out in-flight slots.
   *
   * Wire-schema compatibility: both bridges import the same event
   * schemas from `browser-sniffer-core`, so the forwarded message
   * round-trips without re-encoding.
   */
  readonly sendCollectorMessage: ExpoTransport<Bridges>['sendMessage']
  /** Optional error sink for non-decode failures the bridge would otherwise log. */
  readonly onError?: (error: { id: string; url: string; message: string }) => void
  /** Imperative handle for the parent screen to drive scripted navigation. */
  readonly handleRef?: Ref<RunSyncModalScreenHandle>
}

/**
 * Native modal that hosts a `<BrowserSnifferWebView>` for an "Import
 * Now" flow. The CollectorWebView under the modal stays mounted; this
 * screen captures sniffer events from the page being scraped and
 * forwards them through the host's CollectorBridge transport so the
 * embedded SPA's sync runner sees them live.
 *
 * The active `source` is held in component state so the SPA's
 * scripted navigation (an `Open` web→host message decoded by
 * CollectorWebView) can mount a fresh page mid-flow without
 * remounting the screen. `injectedJavaScriptBeforeContentLoaded` runs
 * on every navigation, so the browser-sniffer-injected script
 * re-installs idempotently on each new page (the state slot keyed by
 * `Symbol.for('browser-sniffer:state')` survives a fresh window).
 */
const RunSyncModalScreen = ({
  source: initialSource,
  sendCollectorMessage,
  onError,
  handleRef,
}: RunSyncModalScreenProps): JSX.Element => {
  const snifferRef = useRef<BrowserSnifferWebViewHandle>(null)
  const [source, setSource] = useState<WebViewSource.Any>(initialSource)

  useImperativeHandle(
    handleRef,
    () => ({
      navigate: (next: WebViewSource.Any): void => {
        setSource(next)
      },
      click: (querySelector: string): void => {
        snifferRef.current?.click(querySelector)
      },
    }),
    []
  )

  // Build the bridge handlers once per `sendCollectorMessage` identity.
  // Each forward dispatches an Effect that the bridge transport drains.
  const handlers = useMemo<SnifferHandlers>(
    () => ({
      Log: () => Effect.void,
      ResponseStart: (event) => sendCollectorMessage(event),
      ResponseData: (event) => sendCollectorMessage(event),
      ResponseFinished: (event) => sendCollectorMessage(event),
      RequestError: (event) =>
        // Forward the bridge message FIRST so a faulty `onError`
        // callback never aborts the SPA-visible event. The callback
        // runs after; its failures are logged through `Effect.logError`
        // instead of bubbling up and tearing down the handler.
        sendCollectorMessage(event).pipe(
          Effect.andThen(
            Effect.sync(() => {
              onError?.(event)
            }).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError('RunSyncModalScreen: onError callback failed', cause)
              )
            )
          )
        ),
      Cancelled: (event) => sendCollectorMessage(event),
      PageLoaded: (event) => sendCollectorMessage(event),
    }),
    [sendCollectorMessage, onError]
  )

  // `BrowserSnifferWebView`'s `source` prop mirrors the untagged
  // `react-native-webview` shape; strip our `_tag` before forwarding so
  // the WebView's typings don't reject the extra field.
  const untaggedSource = useMemo(() => {
    if (source._tag === 'Uri') {
      const { _tag: _, ...rest } = source
      return rest
    }
    const { _tag: _, ...rest } = source
    return rest
  }, [source])

  return (
    <ThemedView style={styles.container}>
      <BrowserSnifferWebView ref={snifferRef} source={untaggedSource} handlers={handlers} />
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
export type { RunSyncModalScreenHandle, RunSyncModalScreenProps }
