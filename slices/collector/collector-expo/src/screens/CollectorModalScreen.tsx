import {
  BrowserSnifferWebView,
  type BrowserSnifferWebViewHandle,
  type SnifferHandlers,
} from 'browser-sniffer-expo'
import type { WebViewSource } from 'collector-fundamentals/model'
import { useCollectorHostMessaging } from 'collector-react'
import { Effect } from 'effect'
import { Spacing, ThemedView } from 'expo-tundraish'
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type Ref,
} from 'react'
import { StyleSheet } from 'react-native'
import { useHost } from '../host-receiver-layer.tsx'

/**
 * Imperative handle exposed via `ref`. The host shell's `onOpen`
 * callback (forwarded from the SPA's `CollectorBridge`) is wired in
 * the parent screen and calls into this handle so the active modal
 * can advance its own BrowserSnifferWebView in response to scripted
 * navigation steps.
 */
interface CollectorModalScreenHandle {
  readonly navigate: (source: WebViewSource.Any) => void
  readonly click: (querySelector: string) => void
}

interface CollectorModalScreenProps {
  /**
   * Initial page the sniffer should load — the bridge-tagged
   * `WebViewSource.Any` the SPA emits in `RequestSniffableWebView`.
   * The screen mirrors this into local state so subsequent `Open`
   * messages from the SPA can re-mount the sniffer at a fresh URL
   * without remounting the modal.
   */
  readonly source: WebViewSource.Any
  /** Optional error sink for non-decode failures the bridge would otherwise log. */
  readonly onError?: (error: { id: string; url: string; message: string }) => void
  /** Imperative handle for the parent screen to drive scripted navigation. */
  readonly handleRef?: Ref<CollectorModalScreenHandle>
}

/**
 * Native modal that hosts a `<BrowserSnifferWebView>` for an "Import
 * Now" flow. The host shell's persistent WebView stays mounted under
 * the modal; this screen decodes sniffer events from the page being
 * scraped via typed `BrowserSnifferBridge.Host` handlers and re-emits
 * them through `CollectorBridge.hostToWeb` into the embedded SPA's
 * bridge. Because the six passthrough schemas are imported verbatim
 * from `browser-sniffer-core` on both sides, the decoded value passes
 * through without conversion.
 *
 * The active `source` is held in component state so the SPA's
 * scripted navigation (an `Open` web→host message decoded by the
 * host shell) can mount a fresh page mid-flow without remounting
 * the screen. `injectedJavaScriptBeforeContentLoaded` runs on every
 * navigation, so the browser-sniffer-injected script re-installs
 * idempotently on each new page (the state slot keyed by
 * `Symbol.for('browser-sniffer:state')` survives a fresh window).
 *
 * The screen also registers a `SnifferControl` on the host's
 * `snifferControlRef` so the SPA's `Click` / `CancelSnifferRequest`
 * messages — decoded by `CollectorBridge.Host.ReceiverLayer` —
 * reach the sniffer page through its imperative handle.
 */
const CollectorModalScreen = ({
  source: initialSource,
  onError,
  handleRef,
}: CollectorModalScreenProps): JSX.Element => {
  const snifferRef = useRef<BrowserSnifferWebViewHandle>(null)
  const [source, setSource] = useState<WebViewSource.Any>(initialSource)

  const { snifferControlRef } = useHost()
  const { sendEffect: sendCollectorHost } = useCollectorHostMessaging()

  // Register the sniffer's imperative surface so inbound `Click` /
  // `CancelSnifferRequest` from the SPA reach the page. Clearing on
  // unmount matches the bridge's "no peer attached" drop policy.
  useEffect(() => {
    snifferControlRef.current = {
      click: (querySelector) => {
        snifferRef.current?.click(querySelector)
      },
      cancelRequest: (id) => {
        snifferRef.current?.cancelRequest(id)
      },
    }
    return (): void => {
      snifferControlRef.current = null
    }
  }, [snifferControlRef])

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

  // Typed handlers decode each sniffer event and re-emit it through
  // `CollectorBridge.hostToWeb` so the embedded SPA's bridge dispatches
  // it. The six passthrough tag schemas (`ResponseStart`,
  // `ResponseData`, `ResponseFinished`, `RequestError`, `Cancelled`,
  // `PageLoaded`) are imported verbatim from `browser-sniffer-core` on
  // both bridge sides, so the decoded value passes through without
  // conversion. `RequestError` additionally fires the optional
  // host-local `onError` callback; `Log` is a deliberate drop.
  const handlers = useMemo<SnifferHandlers>(
    () => ({
      Log: () => Effect.void,
      ResponseStart: (event) => sendCollectorHost(event),
      ResponseData: (event) => sendCollectorHost(event),
      ResponseFinished: (event) => sendCollectorHost(event),
      RequestError: (event) =>
        Effect.sync(() => {
          onError?.(event)
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('CollectorModalScreen: onError callback failed', cause)
          ),
          Effect.zipRight(sendCollectorHost(event))
        ),
      Cancelled: (event) => sendCollectorHost(event),
      PageLoaded: (event) => sendCollectorHost(event),
    }),
    [onError, sendCollectorHost]
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

export { CollectorModalScreen }
export type { CollectorModalScreenHandle, CollectorModalScreenProps }
