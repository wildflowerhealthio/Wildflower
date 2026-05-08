import type { MessageHandler, MessageSchemaRecord } from 'interop-core'
import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { WebViewMessageEvent } from 'react-native-webview'
import type { EmbeddedWebViewHandle } from './embedded-webview.tsx'
import { type ExpoMessageHandlerBundle, makeExpoMessageHandler } from './message-handler.ts'

interface UseMessageHandlerResult<
  Receive extends MessageSchemaRecord,
  Send extends MessageSchemaRecord,
> {
  readonly handler: MessageHandler<Receive, Send>
  /**
   * The imperative-handle ref to attach to `<EmbeddedWebView ref={...}>`.
   * The handler's `sendMessage` reads this ref to push encoded messages
   * into the page.
   */
  readonly webviewHandleRef: RefObject<EmbeddedWebViewHandle | null>
  /**
   * JS to inject via `<EmbeddedWebView injectedScript={...}>`. Publishes
   * `window.__INITIAL_MESSAGES__` so the page-side handler can replay
   * pre-mount messages synchronously before any React render.
   */
  readonly injectedScript: string
  /** Pass to `<EmbeddedWebView onMessage={...}>` to feed page→host messages into the dispatcher. */
  readonly onMessage: (event: WebViewMessageEvent) => void
}

/**
 * React Native hook that builds a {@link MessageHandler} bound to a
 * single embedded WebView. Returns the handler plus the props the
 * consumer needs to wire to `<EmbeddedWebView>`.
 *
 * The hook intentionally does *not* manage the screen-header back
 * chevron. Slice consumers (e.g. `GatekeeperWebView`) wire that
 * themselves on top of the returned handler — they have a concrete
 * `MessageHandler<Receive, Send>` type at that point, so calling
 * `handler.setMessageListener('RouteChanged', ...)` and
 * `handler.sendMessage({_tag: 'NativeBackRequested'})` typechecks
 * cleanly without the cross-cutting type intersection that
 * useMessageHandler would otherwise need.
 *
 * Callers should memoise `receive`, `send`, and `initialMessages` so
 * the handler is stable across renders. Changing any of them rebuilds
 * the handler and disposes the previous one.
 */
const useMessageHandler = <
  Receive extends MessageSchemaRecord,
  Send extends MessageSchemaRecord,
>(opts: {
  readonly receive: Receive
  readonly send: Send
  readonly initialMessages: ReadonlyArray<string>
}): UseMessageHandlerResult<Receive, Send> => {
  const webviewHandleRef = useRef<EmbeddedWebViewHandle>(null)

  const bundle: ExpoMessageHandlerBundle<Receive, Send> = useMemo(
    () =>
      makeExpoMessageHandler(
        { receive: opts.receive, send: opts.send },
        webviewHandleRef,
        opts.initialMessages
      ),
    [opts.receive, opts.send, opts.initialMessages]
  )

  useEffect(
    () => (): void => {
      bundle.handler.dispose()
    },
    [bundle.handler]
  )

  return {
    handler: bundle.handler,
    webviewHandleRef,
    injectedScript: bundle.injectedScript,
    onMessage: bundle.onMessage,
  }
}

export { useMessageHandler }
export type { UseMessageHandlerResult }
