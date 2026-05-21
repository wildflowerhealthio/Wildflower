import {
  BrowserSnifferWebView,
  type BrowserSnifferWebViewHandle,
  type SnifferHandlers,
} from 'browser-sniffer-expo'
import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import { Spacing, ThemedView } from 'expo-tundraish'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type Ref,
} from 'react'
import { StyleSheet } from 'react-native'

/**
 * Subset of sniffer webToHost tags that are pure passthroughs to the
 * embedded SPA's `CollectorBridge`. Their schemas match verbatim
 * (both bridges import the same definitions from `browser-sniffer-core`),
 * so the host can forward the raw wire string straight through —
 * no decode + re-encode round trip.
 *
 * Tags omitted from this set get typed handlers (e.g. `RequestError`
 * still triggers the optional `onError` callback for app-side
 * observability; `Log` is consumed locally).
 */
const PASSTHROUGH_TO_SPA: ReadonlySet<string> = new Set([
  'ResponseStart',
  'ResponseData',
  'ResponseFinished',
  'RequestError',
  'Cancelled',
  'PageLoaded',
])

/**
 * Imperative handle exposed via `ref`. The host shell's `onOpen`
 * callback (forwarded from the SPA's `CollectorBridge`) is wired in
 * the parent screen and calls into this handle so the active modal
 * can advance its own BrowserSnifferWebView in response to scripted
 * navigation steps.
 *
 * `postRawSnifferMessage` is the host's bypass path for raw bridge
 * payloads the SPA sends (`Click` / `CancelSnifferRequest`) — they
 * forward to the sniffer page verbatim without re-encoding. The
 * parent screen wires this to the host shell's `onRawMessage`.
 */
interface RunSyncModalScreenHandle {
  readonly navigate: (source: WebViewSource.Any) => void
  readonly click: (querySelector: string) => void
  readonly postRawSnifferMessage: (rawWire: string) => void
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
   * Raw-forward sink into the embedded SPA's `CollectorBridge`. Every
   * sniffer wire-message whose `_tag` is in {@link PASSTHROUGH_TO_SPA}
   * is forwarded verbatim — no decode + re-encode in the host.
   * Wire this to the host shell's `postRawMessage` handle
   * (e.g. wildflower-expo's `AppShellWebViewHandle.postRawMessage`).
   */
  readonly postRawMessage: (rawWire: string) => void
  /** Optional error sink for non-decode failures the bridge would otherwise log. */
  readonly onError?: (error: { id: string; url: string; message: string }) => void
  /** Imperative handle for the parent screen to drive scripted navigation. */
  readonly handleRef?: Ref<RunSyncModalScreenHandle>
}

/**
 * Native modal that hosts a `<BrowserSnifferWebView>` for an "Import
 * Now" flow. The host shell's persistent WebView stays mounted under
 * the modal; this screen captures sniffer events from the page being
 * scraped and forwards them through `postRawMessage` into
 * the embedded SPA's bridge — schemas match across bridges so the
 * wire string goes through unchanged.
 *
 * The active `source` is held in component state so the SPA's
 * scripted navigation (an `Open` web→host message decoded by the
 * host shell) can mount a fresh page mid-flow without remounting
 * the screen. `injectedJavaScriptBeforeContentLoaded` runs on every
 * navigation, so the browser-sniffer-injected script re-installs
 * idempotently on each new page (the state slot keyed by
 * `Symbol.for('browser-sniffer:state')` survives a fresh window).
 *
 * Typed `SnifferHandlers` are kept only for tags that need
 * host-local observation — `RequestError` to fire the optional
 * `onError` callback, `Log` to drop server-side log spam. The
 * remaining tags ride the raw passthrough.
 */
const RunSyncModalScreen = ({
  source: initialSource,
  postRawMessage,
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
      postRawSnifferMessage: (rawWire: string): void => {
        snifferRef.current?.postRaw(rawWire)
      },
    }),
    []
  )

  // Typed handlers cover the host-local concerns only: `RequestError`
  // surfaces to `onError`; `Log` is a deliberate drop; the rest are
  // forwarded raw via `onRawMessage` below.
  const handlers = useMemo<SnifferHandlers>(
    () => ({
      Log: () => Effect.void,
      ResponseStart: () => Effect.void,
      ResponseData: () => Effect.void,
      ResponseFinished: () => Effect.void,
      RequestError: (event) =>
        Effect.sync(() => {
          onError?.(event)
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('RunSyncModalScreen: onError callback failed', cause)
          )
        ),
      Cancelled: () => Effect.void,
      PageLoaded: () => Effect.void,
    }),
    [onError]
  )

  // Raw forwarder: peek `_tag` from the JSON wire (cheap — single
  // parse, no Schema decode), forward verbatim if it's a passthrough
  // tag. Malformed payloads silently drop (the typed dispatch will
  // also reject them).
  const onRawMessage = useCallback(
    (rawWire: string): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawWire)
      } catch {
        return
      }
      if (parsed === null || typeof parsed !== 'object') return
      const tag = (parsed as { readonly _tag?: unknown })._tag
      if (typeof tag !== 'string' || !PASSTHROUGH_TO_SPA.has(tag)) return
      postRawMessage(rawWire)
    },
    [postRawMessage]
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
      <BrowserSnifferWebView
        ref={snifferRef}
        source={untaggedSource}
        handlers={handlers}
        onRawMessage={onRawMessage}
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

export { RunSyncModalScreen }
export type { RunSyncModalScreenHandle, RunSyncModalScreenProps }
