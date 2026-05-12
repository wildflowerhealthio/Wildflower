import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect, Exit, Layer, Scope } from 'effect'
import {
  BridgeTransport,
  type BareSender,
  type MessageHandler,
  TransportAdapter,
} from 'effect-messaging-core'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type JSX } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * Imperative handle exposed via `ref`. Hosts call `cancelRequest(id)` to
 * stop sniffer events for a specific in-flight request — useful when the
 * downstream parser decides the response is irrelevant and wants to
 * release the chunk-tracking state on the page.
 *
 * The call goes over the same `BridgeTransport` the inbound events use:
 * the host sends `CancelSnifferRequest` as a typed Host→Web bridge
 * message, the injected sniffer's `message`-event listener decodes it
 * and removes the id from its active-request set.
 */
interface BrowserSnifferWebViewHandle {
  cancelRequest(id: string): void
}

/** What the WebView should load. Mirrors `EffectMessagingWebViewSource`. */
type BrowserSnifferWebViewSource = { uri: string } | { html: string; baseUrl?: string }

type SnifferHandlers = MessageHandler.HandlersFor<typeof BrowserSnifferBridge.Host.InboundSchemas>

interface BrowserSnifferWebViewProps {
  /** Page to sniff — either a remote URL or inline HTML. */
  readonly source: BrowserSnifferWebViewSource
  /**
   * Per-tag handlers invoked when the sniffer posts a typed message. Each
   * handler returns an `Effect<void>`; the dispatch fiber catches handler
   * defects, so a throw from one handler doesn't tear down the rest.
   */
  readonly handlers: SnifferHandlers
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
}

/**
 * WebView wrapper that hosts an arbitrary page with the
 * `browser-sniffer-injected` script installed pre-content-load.
 *
 * - Decoded messages reach the supplied `handlers` via
 *   `BridgeTransport`'s dispatch fiber — same machinery the rest of the
 *   slice cluster uses, so handler defects log without taking the page
 *   down and the scope tears down cleanly on unmount.
 * - Host→Web (`CancelSnifferRequest`) sends go through
 *   `webviewRef.current.postMessage(encoded)` — the bridge wires this
 *   in via the {@link TransportAdapter}'s `bareSender`. The injected
 *   sniffer's `message`-event listener handles the wire payload.
 */
const BrowserSnifferWebView = forwardRef<BrowserSnifferWebViewHandle, BrowserSnifferWebViewProps>(
  function BrowserSnifferWebView({ source, handlers }, ref): JSX.Element {
    const webviewRef = useRef<WebView>(null)

    // Build the host-side BridgeTransport once per `handlers` identity.
    // Scoped so the dispatch fiber + queue tear down on unmount.
    const [transport, scope] = useMemo(() => {
      const builtScope = Effect.runSync(Scope.make())
      const bareSender: BareSender = (encoded) =>
        Effect.sync(() => {
          // Pre-mount sends warn and drop; once the WebView is mounted
          // its imperative `postMessage(string)` dispatches a `message`
          // event on the page that the sniffer's listener decodes.
          const wv = webviewRef.current
          if (wv === null) return
          // RN-WebView's `postMessage(string)` is not the `window.postMessage`
          // API and does not take a `targetOrigin`.
          // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
          wv.postMessage(encoded)
        })
      const adapter: TransportAdapter['Type'] = {
        bareSender,
        drainInitial: Effect.succeed([]),
      }
      const layer = BrowserSnifferBridge.Host.ReceiverLayer(handlers)
      const built = Effect.runSync(
        Scope.extend(
          BridgeTransport.make({
            bridges: [BrowserSnifferBridge] as const,
            layers: [layer] as const,
            side: 'Host',
          }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter))),
          builtScope
        )
      )
      return [built, builtScope] as const
    }, [handlers])

    useImperativeHandle(
      ref,
      () => ({
        cancelRequest(id: string): void {
          Effect.runFork(transport.sendMessage({ _tag: 'CancelSnifferRequest', id }))
        },
      }),
      [transport]
    )

    useEffect(
      () => (): void => {
        Effect.runFork(Scope.close(scope, Exit.void))
      },
      [scope]
    )

    const onWebViewMessageEvent = (event: WebViewMessageEvent): void => {
      void Effect.runPromise(transport.enqueue(event.nativeEvent.data))
    }

    return (
      <View style={styles.container}>
        <WebView
          ref={webviewRef}
          source={source}
          onMessage={onWebViewMessageEvent}
          injectedJavaScriptBeforeContentLoaded={snifferScript}
          style={styles.webview}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
        />
      </View>
    )
  }
)

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
})

export { BrowserSnifferWebView }
export type {
  BrowserSnifferWebViewHandle,
  BrowserSnifferWebViewProps,
  BrowserSnifferWebViewSource,
  SnifferHandlers,
}
