/* oxlint-disable no-console -- diagnostic warnings for unknown / malformed
   messages, decode failures, and pre-mount sendMessage drops; they surface
   wiring mistakes that would otherwise be silent. */
import { Either, Schema } from 'effect'
import {
  type BufferedDispatcher,
  makeBufferedDispatcher,
  type MessageHandler,
  type MessageSchemaRecord,
} from 'interop-core'
import type { RefObject } from 'react'
import type { WebViewMessageEvent } from 'react-native-webview'
import type { EmbeddedWebViewHandle } from './embedded-webview.tsx'

interface ExpoMessageHandlerBundle<
  Receive extends MessageSchemaRecord,
  Send extends MessageSchemaRecord,
> {
  readonly handler: MessageHandler<Receive, Send>
  /**
   * JS to inject via `injectedJavaScriptBeforeContentLoaded`. Publishes
   * `window.__INITIAL_MESSAGES__` so the page-side handler can replay
   * pre-mount messages synchronously before any React render.
   */
  readonly injectedScript: string
  /**
   * Handler for the WebView's `onMessage` prop. Decodes the page's posted
   * string against `schemas.receive` and routes through the dispatcher.
   */
  readonly onMessage: (event: WebViewMessageEvent) => void
}

/**
 * Build a {@link MessageHandler} bound to a React Native `WebView`'s
 * postMessage surface.
 *
 * The handler's `sendMessage` encodes the message and pushes it into the
 * page via `webviewHandleRef.current.postMessage(...)`. Pre-mount messages
 * are delivered through `__INITIAL_MESSAGES__` (see {@link injectedScript}),
 * which the page-side handler replays before any subscriber registers.
 */
const makeExpoMessageHandler = <
  Receive extends MessageSchemaRecord,
  Send extends MessageSchemaRecord,
>(
  schemas: { receive: Receive; send: Send },
  webviewHandleRef: RefObject<EmbeddedWebViewHandle | null>,
  initialMessages: ReadonlyArray<string>
): ExpoMessageHandlerBundle<Receive, Send> => {
  const dispatcher: BufferedDispatcher<Receive> = makeBufferedDispatcher<Receive>()

  const decodeAndDispatch = (raw: string): void => {
    let parsedTag: unknown
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return
      parsedTag = (parsed as { _tag?: unknown })._tag
    } catch {
      return
    }
    if (typeof parsedTag !== 'string') return
    const schema = schemas.receive[parsedTag]
    if (schema === undefined) {
      console.warn(`[interop] unknown message tag from page: "${parsedTag}"`)
      return
    }
    const decoded = Schema.decodeUnknownEither(schema)(raw)
    if (Either.isLeft(decoded)) {
      console.warn(`[interop] failed to decode "${parsedTag}":`, decoded.left)
      return
    }
    dispatcher.receive(decoded.right)
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    decodeAndDispatch(event.nativeEvent.data)
  }

  // JSON.stringify wraps the inner-encoded strings safely (escapes quotes,
  // backslashes, line separators) so dropping the result into a JS string
  // context is safe.
  const injectedScript = `window.__INITIAL_MESSAGES__ = ${JSON.stringify(initialMessages)}; true;`

  const sendMessage: MessageHandler<Receive, Send>['sendMessage'] = (message) => {
    // The DecodedMessage type collapses to `any` inside generic code (see
    // makeBufferedDispatcher for the variance background); cast to read
    // the structural shape every message carries.
    const tag = (message as { readonly _tag: string })._tag
    const schema = schemas.send[tag]
    if (schema === undefined) {
      console.warn(`[interop] sendMessage: no schema registered for "${tag}"; dropping`)
      return
    }
    const encoded = Schema.encodeSync(schema)(message)
    if (webviewHandleRef.current !== null) {
      // RN WebView's imperative `postMessage(string)` does not take a
      // `targetOrigin` — different API surface from `window.postMessage`.
      // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
      webviewHandleRef.current.postMessage(encoded)
    } else {
      console.warn(
        `[interop] sendMessage("${tag}"): no WebView handle yet; dropping. ` +
          `Pre-mount messages should ride __INITIAL_MESSAGES__.`
      )
    }
  }

  // Wrap dispatcher methods so consumers can destructure the returned
  // handler (or pass it as a `MessageReader`) without tripping
  // unbound-method lints. The dispatcher's underlying functions are
  // closure-based, so binding doesn't change behavior.
  const handler: MessageHandler<Receive, Send> = {
    setMessageListener: (tag, listener) => dispatcher.setMessageListener(tag, listener),
    consumeBuffered: (tag) => dispatcher.consumeBuffered(tag),
    sendMessage,
    dispose: () => dispatcher.dispose(),
  }

  return { handler, injectedScript, onMessage }
}

export { makeExpoMessageHandler }
export type { ExpoMessageHandlerBundle }
