// oxlint-disable eslint-plugin-unicorn/consistent-function-scoping -- installSniffer's body is stringified via Function.prototype.toString() and injected into arbitrary pages; nested helpers MUST stay inside the function body so they survive the stringification path. Moving them out would break the bundle.
// oxlint-disable eslint-plugin-unicorn/require-post-message-target-origin -- RN-WebView's bridge `postMessage(string)` is not the window `postMessage` API; no `targetOrigin` argument exists (mirrors effect-messaging-react/web-platform-adapter).

import type {
  CancelSnifferRequestMessageBody,
  CancelledMessageBody,
  ClickMessageBody,
  PageLoadedMessageBody,
  RequestErrorMessageBody,
  ResponseDataMessageBody,
  ResponseFinishedMessageBody,
  ResponseStartMessageBody,
} from 'browser-sniffer-core'
import type { Schema } from 'effect'
import type { Logging } from 'effect-messaging-core'

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
 *     `RequestError`, `Cancelled`, `PageLoaded` — see
 *     `browser-sniffer-core/messages` for the schemas.
 *   - Listens for `CancelSnifferRequest` Host→Web messages on
 *     `window`'s `message` event. The handler tightens against confused
 *     deputies by only accepting events whose `source` is `null`
 *     (RN-WebView's injection path); page-side scripts dispatching
 *     synthetic `message` events with a non-null `source` are ignored.
 *
 * Idempotent: a single `Symbol.for('browser-sniffer:state')` slot on
 * `window` stashes the captured native references and tracker state.
 * Re-injecting on the same page finds the slot and exits early after
 * the (harmless) repeat `__Ready`. **Caveat**: if a host re-injects a
 * *newer version* of this script (host app upgraded mid-session, etc.)
 * the early-return uses the stale state and the new logic never
 * installs. The slot carries no version tag; v1 deliberately accepts
 * this limitation. Tracking: re-injection-with-upgrade is out of scope
 * for the collector-stack rollout. Test coverage in
 * `install-sniffer.test.ts`.
 */

/** Wire form posted Web→Host: JSON-stringifiable, base64 `data`, plus the `__Ready` handshake. */
type SnifferOutboundMessage =
  | Schema.Schema.Encoded<typeof Logging.LogMessageBody>
  | Schema.Schema.Encoded<typeof ResponseStartMessageBody>
  | Schema.Schema.Encoded<typeof ResponseDataMessageBody>
  | Schema.Schema.Encoded<typeof ResponseFinishedMessageBody>
  | Schema.Schema.Encoded<typeof RequestErrorMessageBody>
  | Schema.Schema.Encoded<typeof CancelledMessageBody>
  | Schema.Schema.Encoded<typeof PageLoadedMessageBody>
  | { readonly _tag: '__Ready' }

/** Wire form received Host→Web. */
type SnifferInboundMessage =
  | Schema.Schema.Encoded<typeof CancelSnifferRequestMessageBody>
  | Schema.Schema.Encoded<typeof ClickMessageBody>

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

  // Per-level Log emitters. The host re-emits each `Log` message via
  // `console[level](...payload)` on its side, so each page-side
  // `console.<level>(...args)` flows verbatim to the host's matching
  // native sink. Mirrors the `makeLogForLevel` factory in
  // `apps/wildflower-react/src/bridges/transport-provider.tsx`; the
  // injected script can't import the Effect runtime, so this is the
  // plain-JS analogue. `LogLevel` is type-imported from `Logging` so
  // any future expansion of the bridge's level union surfaces here at
  // compile time. (Type-only imports survive `Function.prototype.toString`.)
  const makeLogForLevel =
    (level: Logging.LogLevel) =>
    (...args: unknown[]): void => {
      post({ _tag: 'Log', level, payload: args })
    }
  const logDebug = makeLogForLevel('debug')
  const logInfo = makeLogForLevel('info')
  const logLog = makeLogForLevel('log')
  const logWarning = makeLogForLevel('warn')
  const logError = makeLogForLevel('error')

  // Override the page's console methods so any page-side `console.<level>`
  // call is forwarded to the host as a structured Log. We assign onto the
  // global `console` object directly — its identity is preserved (we only
  // swap the methods, not the object), so any page code that captured a
  // bound reference to `console` still sees the new methods.
  Object.assign(globalThis.console, {
    debug: logDebug,
    info: logInfo,
    log: logLog,
    warn: logWarning,
    error: logError,
  })

  // Per-request correlation key. `Math.random() + 1` keeps the value in
  // `[1, 2)` so `.toString(36)` yields a string of the form
  // `"1.xyz123…"`; `.slice(2)` drops the `"1."` leaving a non-empty
  // base-36 alphanumeric suffix. Good enough for in-page request
  // correlation — no cryptographic guarantees are needed.
  const makeRequestId = (): string => (Math.random() + 1).toString(36).slice(2)

  /**
   * Encode bytes from any input into a base64 string. The
   * `ArrayBufferView` branch preserves `byteOffset` / `byteLength` so
   * a sliced view (`u8.subarray(4, 12)`, a `DataView`, …) encodes
   * exactly the view's range — not the entire backing buffer.
   */
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
      view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    }
    return btoa(Array.from(view, (b) => String.fromCharCode(b)).join(''))
  }

  /**
   * Lossless extraction of headers as ordered `(name, value)` pairs.
   * `Headers.entries()` may collapse repeated headers (notably
   * `Set-Cookie`) under spec-legacy comma joining; when
   * `Headers.getSetCookie()` is available we use it to recover the
   * per-cookie set.
   */
  const headersToWire = (headers: Headers): [string, string][] => {
    const entries = Array.from(headers.entries(), ([name, value]): [string, string] => [
      name.toLowerCase(),
      value,
    ])
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
    if (typeof getSetCookie === 'function') {
      const cookies = getSetCookie.call(headers)
      if (cookies.length > 0) {
        const withoutSetCookie = entries.filter(([name]) => name !== 'set-cookie')
        for (const cookie of cookies) withoutSetCookie.push(['set-cookie', cookie])
        return withoutSetCookie
      }
    }
    return entries
  }

  // Track in-progress request IDs so they can be cancelled.
  const activeRequests = new Set<string>()
  // Per-XHR state keyed by instance — avoids polluting `XMLHttpRequest`
  // instances with `_sniffer*` properties.
  interface XhrState {
    id: string
    url: string
    /** Number of UTF-8 bytes already posted as ResponseData chunks. */
    sentBytes: number
  }
  const xhrState = new WeakMap<XMLHttpRequest, XhrState>()

  // Single shared encoder; the closure preserves it across calls.
  const utf8 = new TextEncoder()

  // One-shot Log emitter so we don't spam for repeated unsupported
  // observations (e.g., XHR `blob` / `document` response types).
  const onceLogged = new Set<string>()
  const logOnce = (key: string, message: string): void => {
    if (onceLogged.has(key)) return
    onceLogged.add(key)
    logInfo(message)
  }

  // Fetch shim — capture the native into a const so the closure has a
  // typed, definitely-defined reference (no `!` later).
  logInfo('Shimming fetch')
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
      // Pre-response throw (DNS failure, TLS error, AbortSignal, …).
      // Emit Log → synthetic ResponseStart → RequestError so the host
      // sees the full Start→terminal pair (host-side `Cancelled` /
      // `RequestError` handlers assume a prior `ResponseStart`).
      // We re-throw so the caller's catch still fires; the synthetic
      // pair is purely the wire-side observation.
      let errorUrl: string
      if (typeof request === 'string') {
        errorUrl = request
      } else if (request instanceof URL) {
        errorUrl = request.toString()
      } else {
        errorUrl = request.url
      }
      const message = err instanceof Error ? err.message : String(err)
      logWarning(`fetch threw before response: ${message}`)
      activeRequests.add(requestId)
      post({
        _tag: 'ResponseStart',
        id: requestId,
        url: errorUrl,
        status: 0,
        statusText: '',
        headers: [],
      })
      activeRequests.delete(requestId)
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
      headers: headersToWire(response.headers),
    })

    // Pin the response identity surface so re-wrapping (below) doesn't
    // silently drop `type` / `url` / `redirected` — code that branches
    // on `response.type === 'opaque'` or reads `response.url` would
    // otherwise see the wrapping defaults.
    const responseType = response.type
    const responseUrl = response.url
    const responseRedirected = response.redirected

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
      const wrapped = new Response(response.body.pipeThrough(ts), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      // Restore the lost-on-wrap properties via property descriptors —
      // `new Response(...)` initialises these to `'default'`, `''`,
      // `false`. Use `defineProperty` because they're read-only own
      // properties on the spec-compliant Response.
      Object.defineProperty(wrapped, 'type', { value: responseType, configurable: true })
      Object.defineProperty(wrapped, 'url', { value: responseUrl, configurable: true })
      Object.defineProperty(wrapped, 'redirected', {
        value: responseRedirected,
        configurable: true,
      })
      response = wrapped
    } else {
      activeRequests.delete(requestId)
      post({ _tag: 'ResponseFinished', id: requestId })
    }

    return response
  }

  // XHR shim — same capture pattern; per-XHR state lives in a WeakMap.
  logInfo('Shimming XMLHttpRequest')
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
      let headers: [string, string][] = []
      if (typeof xhr.getAllResponseHeaders === 'function') {
        const rawHeaders = xhr.getAllResponseHeaders()
        headers = rawHeaders
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line): [string, string] => {
            const idx = line.indexOf(':')
            return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]
          })
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

    /**
     * Flush any not-yet-sent text-mode payload. `sentBytes` is a UTF-8
     * byte count (not a character index) so chunks across non-BMP code
     * points (surrogate pairs) stay byte-correct on the host side.
     */
    const flushTextChunk = (xhr: XMLHttpRequest): void => {
      if (xhr.responseType !== '' && xhr.responseType !== 'text') return
      const fullBytes = utf8.encode(xhr.responseText)
      if (fullBytes.byteLength <= state.sentBytes) return
      const chunkBytes = fullBytes.subarray(state.sentBytes)
      post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunkBytes) })
      state.sentBytes = fullBytes.byteLength
    }

    /**
     * Final-flush for non-text response types (`json`, `arraybuffer`).
     * `xhr.response` is only well-defined after `load`, so this is
     * called once from the `load` handler. `blob` and `document` are
     * skipped with a one-shot Log (their bodies are async-only on
     * `blob` and DOM-shaped on `document` — outside the v1 surface).
     */
    const flushFinalNonTextBody = (xhr: XMLHttpRequest): void => {
      if (xhr.responseType === 'json') {
        const json = JSON.stringify(xhr.response)
        if (json === undefined) return
        const bytes = utf8.encode(json)
        if (bytes.byteLength === 0) return
        post({ _tag: 'ResponseData', id: requestId, data: toBase64(bytes) })
        return
      }
      if (xhr.responseType === 'arraybuffer') {
        const buf: unknown = xhr.response
        if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return
        post({ _tag: 'ResponseData', id: requestId, data: toBase64(buf) })
        return
      }
      if (xhr.responseType === 'blob') {
        logOnce(
          'xhr-blob-unsupported',
          'XHR responseType=blob captured but body is invisible to the sniffer (v1 limitation)'
        )
        return
      }
      if (xhr.responseType === 'document') {
        logOnce(
          'xhr-document-unsupported',
          'XHR responseType=document captured but body is invisible to the sniffer (v1 limitation)'
        )
        return
      }
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
        flushFinalNonTextBody(this)
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

  // Page content capture on window-level `load`. `PageLoaded` is now
  // just a notification (`url`, `pageContentId`); the DOM body streams
  // through the standard `ResponseStart`/`ResponseData`/`ResponseFinished`
  // triple. Chunking the body (vs. a single multi-MB `postMessage`) keeps
  // us under RN-WebView's binder size limits on Android and the iOS
  // truncation threshold.
  //
  // `Element.outerHTML` is defined on every `Element` (not just
  // `HTMLElement`), so XML-content documents (e.g. RSS) also serialise,
  // just with HTML rules. Out of scope: DOCTYPE / processing
  // instructions / XML declarations.
  const PAGE_CONTENT_CHUNK_BYTES = 65536
  const pageLoadHandler = (): void => {
    const pageContentId = makeRequestId()
    const content = document.documentElement.outerHTML
    const bytes = utf8.encode(content)
    post({ _tag: 'PageLoaded', url: win.location.href, pageContentId })
    activeRequests.add(pageContentId)
    post({
      _tag: 'ResponseStart',
      id: pageContentId,
      url: win.location.href,
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/html']],
    })
    for (let offset = 0; offset < bytes.byteLength; offset += PAGE_CONTENT_CHUNK_BYTES) {
      if (!activeRequests.has(pageContentId)) break
      const slice = bytes.subarray(offset, offset + PAGE_CONTENT_CHUNK_BYTES)
      post({ _tag: 'ResponseData', id: pageContentId, data: toBase64(slice) })
    }
    if (activeRequests.has(pageContentId)) {
      activeRequests.delete(pageContentId)
      post({ _tag: 'ResponseFinished', id: pageContentId })
    }
  }
  win.addEventListener('load', pageLoadHandler)

  // Host→Web bridge messages arrive as `message` events on `window`
  // (via `react-native-webview`'s `webViewRef.postMessage`). RN-WebView's
  // host-side injection dispatches with `event.source === null`; any
  // `message` event whose `source` is a `Window` or `MessagePort` is
  // page-originated (iframe, opener, in-page script) and must be
  // rejected — otherwise any third-party script on the page can
  // `postMessage({_tag:'CancelSnifferRequest', id})` and silently
  // suppress sniffer output for arbitrary ids.
  //
  // The bridge wire format is a JSON-stringified tagged struct; we
  // parse by hand because the schema runtime can't survive
  // `installSniffer.toString()`. The `SnifferInboundMessage` type
  // keeps field names honest at compile time; we still reject
  // malformed payloads at runtime.
  //
  // On a mid-stream cancel we emit `Cancelled` as the terminal
  // observation so the host can release per-id state without
  // waiting for a `ResponseFinished` that won't come.
  //
  // `Click` runs `document.querySelector(querySelector)?.click()` —
  // best-effort, no feedback on a missing element (the host
  // typically retries by waiting for the next `PageLoaded` to land
  // before re-sending).
  const hostMessageHandler = (event: MessageEvent): void => {
    if (event.source !== null) return
    if (typeof event.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const msg = parsed as Partial<SnifferInboundMessage>
    switch (msg._tag) {
      case 'CancelSnifferRequest': {
        if (typeof msg.id !== 'string') return
        const wasActive = activeRequests.has(msg.id)
        activeRequests.delete(msg.id)
        if (wasActive) {
          post({ _tag: 'Cancelled', id: msg.id })
        }
        return
      }
      case 'Click': {
        if (typeof msg.querySelector !== 'string' || msg.querySelector.length === 0) return
        // `HTMLElement.click()` exists on the HTMLElement prototype; a
        // generic `Element` (SVG, etc.) is unlikely as a click target
        // but the cast keeps the call site honest.
        const target = document.querySelector(msg.querySelector)
        if (target !== null && 'click' in target && typeof target.click === 'function') {
          target.click()
        }
        return
      }
      case undefined:
      default: {
        logWarning(`Unknown inbound message tag: ${String(msg._tag)}`)
        return
      }
    }
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
