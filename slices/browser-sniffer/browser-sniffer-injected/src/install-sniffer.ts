// oxlint-disable eslint-plugin-unicorn/consistent-function-scoping -- installSniffer's body is stringified via Function.prototype.toString() and injected into arbitrary pages; nested helpers MUST stay inside the function body so they survive the stringification path. Moving them out would break the bundle.
// oxlint-disable eslint-plugin-unicorn/require-post-message-target-origin -- RN-WebView's bridge `postMessage(string)` is not the window `postMessage` API; no `targetOrigin` argument exists (mirrors effect-messaging-react/web-platform-adapter).

import type {
  CancelSnifferRequestMessageBody,
  LogMessageBody,
  PageLoadedMessageBody,
  RequestErrorMessageBody,
  ResponseDataMessageBody,
  ResponseFinishedMessageBody,
  ResponseStartMessageBody,
} from 'browser-sniffer-core'
import type { Schema } from 'effect'

/**
 * Browser-side sniffer installed into an arbitrary third-party page.
 *
 * The injected JS bundle is produced by `Function.prototype.toString()`
 * on {@link installSniffer} — meaning every helper, every runtime
 * reference, and every cross-call piece of state must live *inside*
 * the function body. Top-level value imports or closures over module
 * scope would resolve to nothing in the injected page. Type-only
 * imports (the message body schemas, used to type {@link SnifferOutboundMessage}
 * / {@link SnifferInboundMessage}) are erased at compile time and so
 * do survive.
 *
 * Wire format:
 *   - Posts `{"_tag":"__Ready"}` first — handshake signal for the host
 *     side's `BridgeTransport` (resolves the send-gating `Deferred` so
 *     Host→Web messages can flow).
 *   - Posts `Log`, `ResponseStart`, `ResponseData`, `ResponseFinished`,
 *     `RequestError`, `PageLoaded` — see `browser-sniffer-core/messages`
 *     for the schemas.
 *   - Listens for `CancelSnifferRequest` Host→Web messages on
 *     `window`'s `message` event and removes the matching id from the
 *     active-request set. Decoded by hand because the bridge's runtime
 *     schema machinery cannot survive `installSniffer.toString()`; the
 *     {@link SnifferInboundMessage} type keeps the field names honest.
 *
 * Idempotent: a single `Symbol.for('browser-sniffer:state')` slot on
 * `window` stashes the captured native references and tracker state.
 * Re-injecting on the same page finds the slot and exits early after
 * the (harmless) repeat `__Ready`. Test coverage in
 * `install-sniffer.test.ts`.
 */

/** Wire form posted Web→Host: JSON-stringifiable, base64 `data`, plus the `__Ready` handshake. */
type SnifferOutboundMessage =
  | Schema.Schema.Encoded<typeof LogMessageBody>
  | Schema.Schema.Encoded<typeof ResponseStartMessageBody>
  | Schema.Schema.Encoded<typeof ResponseDataMessageBody>
  | Schema.Schema.Encoded<typeof ResponseFinishedMessageBody>
  | Schema.Schema.Encoded<typeof RequestErrorMessageBody>
  | Schema.Schema.Encoded<typeof PageLoadedMessageBody>
  | { readonly _tag: '__Ready' }

/** Wire form received Host→Web. */
type SnifferInboundMessage = Schema.Schema.Encoded<typeof CancelSnifferRequestMessageBody>

interface SnifferState {
  readonly nativeFetch: typeof globalThis.fetch
  readonly nativeXHROpen: XMLHttpRequest['open']
  readonly nativeXHRSend: XMLHttpRequest['send']
  readonly activeRequests: Set<string>
  readonly pageLoadHandler: () => void
  readonly hostMessageHandler: (event: MessageEvent) => void
}

interface SnifferWindowExtensions {
  ReactNativeWebView?: {
    postMessage(data: string): void
  }
}

/**
 * Public `Symbol.for` key under which the sniffer stashes its state on
 * `window`. Tests use this to reset between cases; the injected
 * function body looks up the same registry symbol via
 * `Symbol.for('browser-sniffer:state')` (a literal string — closure
 * capture over `SNIFFER_STATE_KEY` would not survive the
 * `Function.prototype.toString()` path).
 */
const SNIFFER_STATE_KEY: symbol = Symbol.for('browser-sniffer:state')

/**
 * Install the sniffer on the current page. Idempotent. Posts `__Ready`
 * immediately so the host transport's send-gating handshake completes
 * before the first network event fires.
 */
const installSniffer = function (): void {
  const win = window as Window & SnifferWindowExtensions
  // Single state slot keyed by a registry symbol — eliminates name
  // collisions with arbitrary host-page globals and gives idempotency
  // (re-injection finds the slot and returns early). `unique symbol`
  // on the `const` lets the computed-property type below name *this
  // specific slot* (`[stateKey]: …`) rather than every possible symbol
  // key (`[k: symbol]: …`).
  const stateKey: unique symbol = Symbol.for('browser-sniffer:state')
  type WinWithState = typeof win & { [stateKey]: SnifferState | undefined }
  // The cast adds the (currently-absent) state slot to the window's
  // type; runtime semantics are unchanged.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const winWithState = win as WinWithState

  const post = (msg: SnifferOutboundMessage): void => {
    if (
      win.ReactNativeWebView !== undefined &&
      typeof win.ReactNativeWebView.postMessage === 'function'
    ) {
      win.ReactNativeWebView.postMessage(JSON.stringify(msg))
    }
  }

  // The handshake fires on every call (re-resolving an already-resolved
  // BridgeTransport Deferred is a no-op in Effect) so a re-injection
  // still wakes a host that mounted after the original install.
  post({ _tag: '__Ready' })

  if (winWithState[stateKey] !== undefined) return

  // Per-request correlation key. `Math.random() + 1` keeps the value in
  // `[1, 2)` so `.toString(36)` yields a string of the form
  // `"1.xyz123…"`; `.slice(2)` drops the `"1."` leaving a non-empty
  // base-36 alphanumeric suffix. Good enough for in-page request
  // correlation — no cryptographic guarantees are needed.
  const makeRequestId = (): string => (Math.random() + 1).toString(36).slice(2)

  const toBase64 = (input: string | ArrayBuffer | ArrayBufferView): string => {
    if (typeof input === 'string') {
      return btoa(
        Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join('')
      )
    }
    let view: Uint8Array
    if (input instanceof Uint8Array) {
      view = input
    } else if (input instanceof ArrayBuffer) {
      view = new Uint8Array(input)
    } else {
      view = new Uint8Array(input.buffer)
    }
    return btoa(Array.from(view, (b) => String.fromCharCode(b)).join(''))
  }

  // Track in-progress request IDs so they can be cancelled.
  const activeRequests = new Set<string>()
  // Per-XHR state keyed by instance — avoids polluting `XMLHttpRequest`
  // instances with `_sniffer*` properties.
  interface XhrState {
    id: string
    url: string
    sentBytes: number
  }
  const xhrState = new WeakMap<XMLHttpRequest, XhrState>()

  // Fetch shim — capture the native into a const so the closure has a
  // typed, definitely-defined reference (no `!` later).
  post({ _tag: 'Log', log: 'Shimming fetch' })
  const nativeFetch = win.fetch.bind(win)

  win.fetch = async function (
    this: unknown,
    request: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const requestId = makeRequestId()
    let url: string
    let response: Response

    try {
      if (typeof request === 'string') {
        url = request
        response = await nativeFetch(new Request(request, init))
      } else if (request instanceof URL) {
        url = request.toString()
        response = await nativeFetch(request, init)
      } else {
        url = request.url
        response = await nativeFetch(request, init)
      }
    } catch (err) {
      let errorUrl: string
      if (typeof request === 'string') {
        errorUrl = request
      } else if (request instanceof URL) {
        errorUrl = request.toString()
      } else {
        errorUrl = request.url
      }
      const message = err instanceof Error ? err.message : String(err)
      post({ _tag: 'RequestError', id: requestId, url: errorUrl, message })
      throw err
    }

    activeRequests.add(requestId)

    post({
      _tag: 'ResponseStart',
      id: requestId,
      url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    })

    if (response.body !== null) {
      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller): void {
          if (!activeRequests.has(requestId)) {
            controller.enqueue(chunk)
            return
          }
          post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunk) })
          controller.enqueue(chunk)
        },
        flush(): void {
          if (!activeRequests.has(requestId)) return
          activeRequests.delete(requestId)
          post({ _tag: 'ResponseFinished', id: requestId })
        },
      })
      response = new Response(response.body.pipeThrough(ts), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } else {
      activeRequests.delete(requestId)
      post({ _tag: 'ResponseFinished', id: requestId })
    }

    return response
  }

  // XHR shim — same capture pattern; per-XHR state lives in a WeakMap.
  post({ _tag: 'Log', log: 'Shimming XMLHttpRequest' })
  // The captured prototype methods are always invoked via `.call(this, …)`
  // below, so the `unbound-method` rule's concern (lost `this`) doesn't
  // apply — we re-supply `this` at every call site.
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const nativeXHROpen = XMLHttpRequest.prototype.open
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const nativeXHRSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    xhrState.set(this, { id: makeRequestId(), url: String(url), sentBytes: 0 })
    nativeXHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  } as XMLHttpRequest['open']

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const state = xhrState.get(this) ?? { id: makeRequestId(), url: '', sentBytes: 0 }
    xhrState.set(this, state)
    const requestId = state.id
    let startSent = false

    activeRequests.add(requestId)

    const ensureStartSent = (xhr: XMLHttpRequest): void => {
      if (startSent) return
      startSent = true
      let headers: Record<string, string> = {}
      if (typeof xhr.getAllResponseHeaders === 'function') {
        const rawHeaders = xhr.getAllResponseHeaders()
        headers = Object.fromEntries(
          rawHeaders
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const idx = line.indexOf(':')
              return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]
            })
        )
      }
      post({
        _tag: 'ResponseStart',
        id: requestId,
        url: state.url,
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
      })
    }

    // Flush any text-mode responseText not yet sent. Shared by progress + load
    // handlers; without the load-side call, the tail of the response after the
    // last `progress` event would be lost.
    const flushTextChunk = (xhr: XMLHttpRequest): void => {
      if (xhr.responseType !== '' && xhr.responseType !== 'text') return
      const chunk = xhr.responseText.slice(state.sentBytes)
      if (chunk === '') return
      post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunk) })
      state.sentBytes = xhr.responseText.length
    }

    this.addEventListener('progress', () => {
      // Guard against stale listeners from XHR reuse — `xhrState.get(this).id`
      // can rotate if `open()` is called again on the same instance.
      if (xhrState.get(this)?.id !== requestId) return
      if (!activeRequests.has(requestId)) return
      ensureStartSent(this)
      flushTextChunk(this)
    })

    this.addEventListener(
      'load',
      () => {
        if (xhrState.get(this)?.id !== requestId) return
        if (!activeRequests.has(requestId)) return
        ensureStartSent(this)
        flushTextChunk(this)
        activeRequests.delete(requestId)
        post({ _tag: 'ResponseFinished', id: requestId })
      },
      { once: true }
    )

    this.addEventListener(
      'error',
      () => {
        activeRequests.delete(requestId)
        post({
          _tag: 'RequestError',
          id: requestId,
          url: state.url,
          message: 'XMLHttpRequest error',
        })
      },
      { once: true }
    )
    this.addEventListener(
      'abort',
      () => {
        activeRequests.delete(requestId)
        post({ _tag: 'ResponseFinished', id: requestId })
      },
      { once: true }
    )

    nativeXHRSend.call(this, body ?? null)
  } as XMLHttpRequest['send']

  // Page content capture on window-level `load`. We post the HTML-
  // serialized root element — `Element.outerHTML` is defined on every
  // `Element` (not just `HTMLElement`), so XML-content documents (e.g.
  // RSS) also serialize, just with HTML rules (void-element handling,
  // attribute case). Out of scope: DOCTYPE / processing instructions /
  // XML declarations.
  //
  // For non-HTML payloads the WebView itself is the first responder —
  // RN-WebView wraps `text/plain` in `<pre>`, embeds images via `<img>`,
  // and refuses or synthesizes a host page for binary content. Our
  // handler runs against that already-HTML DOM, never raw bytes; see
  // `install-sniffer.test.ts` for the plain-text + binary-shaped cases.
  // If a consumer ever needs strict XML serialization or the DOCTYPE,
  // switch to `XMLSerializer.serializeToString(document)`.
  const pageLoadHandler = (): void => {
    post({
      _tag: 'PageLoaded',
      url: win.location.href,
      content: document.documentElement.outerHTML,
    })
  }
  win.addEventListener('load', pageLoadHandler)

  // Host→Web bridge messages arrive as `message` events on `window`
  // (via `react-native-webview`'s `webViewRef.postMessage`). The
  // bridge wire format is a JSON-stringified tagged struct; we parse
  // by hand because the schema runtime can't survive
  // `installSniffer.toString()`. The `SnifferInboundMessage` type
  // keeps the field names honest at compile time; we still reject
  // malformed payloads at runtime.
  const hostMessageHandler = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const msg = parsed as Partial<SnifferInboundMessage>
    if (msg._tag !== 'CancelSnifferRequest') return
    if (typeof msg.id !== 'string') return
    activeRequests.delete(msg.id)
  }
  win.addEventListener('message', hostMessageHandler)

  winWithState[stateKey] = {
    nativeFetch,
    nativeXHROpen,
    nativeXHRSend,
    activeRequests,
    pageLoadHandler,
    hostMessageHandler,
  }
}

export { installSniffer, SNIFFER_STATE_KEY }
export type { SnifferInboundMessage, SnifferOutboundMessage, SnifferState, SnifferWindowExtensions }
