/* oxlint-disable no-console -- diagnostic warnings for unknown / malformed
   messages, decode failures, and standalone-web fall-throughs; they surface
   wiring mistakes that would otherwise be silent. */
import { Either, Schema } from 'effect'
import {
  type BufferedDispatcher,
  makeBufferedDispatcher,
  type MessageHandler,
  type MessageSchemaRecord,
} from 'interop-core'

/**
 * Window globals the embedded SPA observes. Both are deleted by
 * {@link makeWebMessageHandler} once consumed so a hot reload doesn't
 * double-replay.
 */
type InteropWindowGlobals = {
  /** Pre-encoded message strings the host injected before the bundle ran. */
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

/**
 * Build a {@link MessageHandler} bound to the browser's `window.postMessage`
 * surface. Constructs synchronously: any `__INITIAL_MESSAGES__` injected by
 * the Expo host are replayed *before* this function returns, so a caller can
 * `consumeBuffered(...)` the queue and seed pre-React state (e.g. the
 * initial route on `<MemoryRouter>`) without a placeholder-mount flicker.
 *
 * The `message` event listener is attached on construction; call
 * `dispose()` to detach.
 */
const makeWebMessageHandler = <
  Receive extends MessageSchemaRecord,
  Send extends MessageSchemaRecord = Receive,
>(schemas: {
  receive: Receive
  send: Send
}): MessageHandler<Receive, Send> => {
  const dispatcher: BufferedDispatcher<Receive> = makeBufferedDispatcher<Receive>()

  const decodeAndDispatch = (raw: string, source: 'live' | 'initial'): void => {
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
      console.warn(`[interop] unknown ${source} message tag: "${parsedTag}"`)
      return
    }
    const decoded = Schema.decodeUnknownEither(schema)(raw)
    if (Either.isLeft(decoded)) {
      console.warn(`[interop] failed to decode ${source} message "${parsedTag}":`, decoded.left)
      return
    }
    dispatcher.receive(decoded.right)
  }

  // Live transport: the RN host posts to web by injecting JS that calls
  // `window.postMessage`, so legitimate events have `event.source === window`
  // and the page's own origin. Anything else (iframe, browser extension,
  // foreign origin) is ignored.
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== window) return
    if (event.origin !== window.location.origin && event.origin !== '') return
    if (typeof event.data !== 'string') return
    decodeAndDispatch(event.data, 'live')
  }
  window.addEventListener('message', onMessage)

  // Synchronous replay: the host serializes pre-mount messages into
  // `window.__INITIAL_MESSAGES__` via `injectedJavaScriptBeforeContentLoaded`.
  // We drain it here, before returning, so callers can `consumeBuffered`
  // immediately afterwards.
  const winGlobals = window as Window & InteropWindowGlobals
  const initial = winGlobals.__INITIAL_MESSAGES__
  if (Array.isArray(initial)) {
    for (const entry of initial) {
      if (typeof entry !== 'string') continue
      decodeAndDispatch(entry, 'initial')
    }
    delete winGlobals.__INITIAL_MESSAGES__
  }

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
    if (winGlobals.ReactNativeWebView !== undefined) {
      // RN's WebView bridge `postMessage(string)` doesn't take a
      // `targetOrigin` — different API surface from `window.postMessage`.
      // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
      winGlobals.ReactNativeWebView.postMessage(encoded)
    } else {
      console.warn(
        `[interop] sendMessage("${tag}"): no ReactNativeWebView in window; ` +
          `running standalone? message dropped.`
      )
    }
  }

  const dispose = (): void => {
    window.removeEventListener('message', onMessage)
    dispatcher.dispose()
  }

  // Wrap dispatcher methods so consumers can destructure the returned
  // handler (or pass it as a `MessageReader`) without tripping
  // unbound-method lints. The dispatcher's underlying functions are
  // closure-based, so binding doesn't change behavior.
  return {
    setMessageListener: (tag, listener) => dispatcher.setMessageListener(tag, listener),
    consumeBuffered: (tag) => dispatcher.consumeBuffered(tag),
    sendMessage,
    dispose,
  }
}

export { makeWebMessageHandler }
export type { InteropWindowGlobals }
