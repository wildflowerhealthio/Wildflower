// oxlint-disable eslint-plugin-unicorn/consistent-function-scoping -- installSniffer is esbuild-bundled at build time and injected into arbitrary third-party pages; nested helpers MUST stay inside the function body so they're captured in the IIFE bundle. Moving them out would break the bundle.

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
import type { TauriEventApi } from 'effect-messaging-tauri'
import type { JsonValue } from 'kitchen-sink/schema'

/**
 * Browser-side sniffer installed into an arbitrary third-party page.
 *
 * The injected JS bundle is produced ahead of time by
 * `scripts/build-tauri-bootstrap.mts`, which esbuild-bundles this
 * function as part of a self-contained IIFE — meaning every helper,
 * every runtime reference, and every cross-call piece of state must
 * live *inside* the function body. Top-level value imports or closures
 * over module scope would resolve to nothing in the injected page.
 * Type-only imports (the message body schemas, `TauriEventApi`) are
 * erased at compile time and so do survive.
 *
 * Wire format:
 *   - Emits `Log`, `ResponseStart`, `ResponseData`, `ResponseFinished`,
 *     `RequestError`, `Cancelled`, `PageLoaded` as structured payloads
 *     on the single multiplexed `BRIDGE_EVENT` Tauri channel; the
 *     message's `_tag` field is the dispatch discriminator on the
 *     receiving side. `void eventBus.emit(...)` is fire-and-forget
 *     from this module — outbound ordering across a synchronous burst
 *     is enforced by the wrapping `makeFilteringEventBus`'s
 *     Promise-chain serializer (see
 *     `filter-tauri-internal.ts`). Tauri only guarantees FIFO within a
 *     single event name, so the single-channel scheme is what keeps
 *     `ResponseData` chunks (~64KB each) reassembling in order on the
 *     host side.
 *   - Listens for Host→Web messages on the same `BRIDGE_EVENT` channel
 *     and demuxes by `payload._tag` (`CancelSnifferRequest` / `Click`).
 *     No window `message`-event indirection, no `source === null`
 *     guard: a Tauri listener can only be invoked by Tauri's IPC, so
 *     page scripts can't spoof inbound messages.
 *
 * Idempotent: a single `Symbol.for('browser-sniffer:state')` slot on
 * `window` stashes the captured native references, tracker state, and
 * pending unlisten functions. Re-injecting on the same page finds the
 * slot, drains the previous-run unlistens, and exits early. **Caveat**:
 * if a host re-injects a *newer version* of this script (host app
 * upgraded mid-session) the early-return uses the stale state and the
 * new logic never installs. The slot carries no version tag; v1
 * deliberately accepts this limitation. Test coverage in
 * `tests/install-sniffer.test.ts`.
 */

/** Wire form posted Web→Host: JSON-stringifiable, base64 `data`. */
type SnifferOutboundMessage =
  | Schema.Schema.Encoded<typeof Logging.LogMessageBody>
  | Schema.Schema.Encoded<typeof ResponseStartMessageBody>
  | Schema.Schema.Encoded<typeof ResponseDataMessageBody>
  | Schema.Schema.Encoded<typeof ResponseFinishedMessageBody>
  | Schema.Schema.Encoded<typeof RequestErrorMessageBody>
  | Schema.Schema.Encoded<typeof CancelledMessageBody>
  | Schema.Schema.Encoded<typeof PageLoadedMessageBody>

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
  /** Resolved `event.listen(...)` cleanups; drained on re-injection. */
  readonly unlistens: Array<(() => void) | Promise<() => void>>
}

/**
 * Public `Symbol.for` key under which the sniffer stashes its state on
 * `window`. Tests use this to reset between cases; the injected
 * function body looks up the same registry symbol via
 * `Symbol.for('browser-sniffer:state')` (a literal string — closure
 * capture over `SNIFFER_STATE_KEY` would not survive esbuild's IIFE
 * boundary).
 */
const SNIFFER_STATE_KEY: symbol = Symbol.for('browser-sniffer:state')

/**
 * Tauri event name for the multiplexed bridge channel. Hardcoded
 * (rather than imported from `effect-messaging-tauri`) so the
 * sniffer's bundled IIFE keeps its own copy and the
 * `bootstrap.test.ts` drift guard catches divergence between the
 * bundled bootstrap and the canonical TS constant. Mirrors
 * `BRIDGE_EVENT` in
 * `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`.
 */
const BRIDGE_EVENT = 'bridge'

/**
 * Install the sniffer on the current page. Idempotent. On re-injection,
 * drains any pending unlistens from the previous run before short-
 * circuiting on the symbol-keyed state slot.
 *
 * Takes the Tauri event bus as an explicit parameter so the function
 * is testable without mocking `window.__TAURI__` — the
 * `tauri-sniffer-entry.ts` wrapper looks the global up once and passes
 * it in.
 */
const installSniffer = function (eventBus: TauriEventApi): void {
  const win = window
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

  // On re-injection (the script ran on a previous page in this webview)
  // drain the prior run's listener cleanups before the early-return.
  // Without this, every navigation accumulates listener IDs on the
  // Rust side that point at the destroyed JS context.
  const existing = winWithState[stateKey]
  if (existing !== undefined) {
    for (const entry of existing.unlistens) {
      void Promise.resolve(entry).then((unlisten) => {
        unlisten()
      })
    }
    return
  }

  const post = (msg: SnifferOutboundMessage): void => {
    void eventBus.emit(BRIDGE_EVENT, msg)
  }

  // Per-level Log emitters. The host re-emits each `Log` message via
  // `console[level](...payload)` on its side, so each page-side
  // `console.<level>(...args)` flows verbatim to the host's matching
  // native sink. Mirrors the `makeLogForLevel` factory in
  // `apps/wildflower-react/src/bridges/build-transport.ts`; the
  // injected script can't import the Effect runtime, so this is the
  // plain-JS analogue. `LogLevel` is type-imported from `Logging` so
  // any future expansion of the bridge's level union surfaces here at
  // compile time. (Type-only imports survive esbuild's bundle.)
  const makeLogForLevel =
    (level: Logging.LogLevel) =>
    (...args: unknown[]): void => {
      // Try to log, but fail for unsafe payloads. We assert the
      // JSON-safe shape rather than validating it: `logging.ts` narrows
      // with `Schema.is(JsonValue)`, but that's a runtime value and only
      // type-only imports survive this file's IIFE bundle — so the
      // schema guard isn't available here. The `catch` below is the
      // runtime backstop: a non-JSON-safe arg makes `post`'s encode
      // throw and we fall through to the warn payload.
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        post({ _tag: 'Log', level, payload: args as readonly JsonValue[] })
      } catch {
        post({ _tag: 'Log', level: 'warn', payload: ['JSON unsafe payload failed to log'] })
      }
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
    /** Tauri-internal IPC request — `send` hands to native, unsniffed. */
    internal: boolean
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

  // Tauri's own IPC transport (`@tauri-apps/api`) issues
  // `fetch('ipc://localhost/...')` from this same JS context, so without
  // a guard every host command/event gets re-sniffed and forwarded back
  // as a `ResponseStart`/`RequestError` pair pointing at the internal IPC
  // URL — re-entering the bridge and flooding the collector with
  // untracked ids. Skipping these URLs at the shim source (rather than
  // emitting then filtering downstream) keeps the wire clean; the fetch
  // itself still runs, we just hand straight to native and emit nothing.
  const isTauriInternalUrl = (candidate: string): boolean =>
    candidate.startsWith('ipc://') ||
    candidate.startsWith('tauri://') ||
    candidate.startsWith('http://ipc.localhost') ||
    candidate.startsWith('https://ipc.localhost') ||
    candidate.startsWith('http://tauri.localhost') ||
    candidate.startsWith('https://tauri.localhost')

  // Fetch shim — capture the native into a const so the closure has a
  // typed, definitely-defined reference (no `!` later).
  logInfo('Shimming fetch')
  const nativeFetch = win.fetch.bind(win)

  win.fetch = async function (
    this: unknown,
    request: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // Tauri-internal IPC — hand straight to native, unsniffed (see
    // `isTauriInternalUrl`). Pass the original input through unchanged so
    // we don't re-wrap a string in `new Request(...)` (which rejects the
    // custom `ipc:` scheme in some engines).
    const probeUrl =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url
    if (isTauriInternalUrl(probeUrl)) {
      return nativeFetch(request, init)
    }

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
    const urlStr = String(url)
    xhrState.set(this, {
      id: makeRequestId(),
      url: urlStr,
      sentBytes: 0,
      internal: isTauriInternalUrl(urlStr),
    })
    nativeXHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  } as XMLHttpRequest['open']

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const state = xhrState.get(this) ?? {
      id: makeRequestId(),
      url: '',
      sentBytes: 0,
      internal: false,
    }
    xhrState.set(this, state)
    // Tauri-internal IPC — run it natively without sniffing (see
    // `isTauriInternalUrl`).
    if (state.internal) {
      nativeXHRSend.call(this, body ?? null)
      return
    }
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
  // triple. Chunking the body (vs. a single multi-MB emit) keeps
  // per-message size bounded so the host's IPC transport doesn't have
  // to special-case large payloads.
  //
  // `Element.outerHTML` is defined on every `Element` (not just
  // `HTMLElement`), so XML-content documents (e.g. RSS) also serialise,
  // just with HTML rules. Out of scope: DOCTYPE / processing
  // instructions / XML declarations.
  const PAGE_CONTENT_CHUNK_BYTES = 65536
  // Some browsers — Safari most reliably for `application/json` responses
  // — fire `load` once the response is downloaded but build the
  // `<html><body><pre>{json}</pre></body></html>` viewer wrapper
  // asynchronously over the following frame(s). Capturing
  // `documentElement.outerHTML` synchronously inside the `load` listener
  // then sees an empty document and emits a zero-byte page snapshot.
  // The retry below re-schedules on `requestAnimationFrame` (twice — one
  // to flush layout, one to land after the viewer's first paint) while
  // the document still looks unbuilt. The `attempt` counter caps retries
  // so a genuinely empty document still terminates.
  const MAX_PAGE_LOAD_RETRIES = 8
  // Content types WebKit renders into a `<body><pre>…</pre></body>`
  // viewer a frame or two *after* `load` fires. Only these force the
  // `<pre>`-presence wait: XML is shown as a tree (no `<pre>`) and HTML
  // is its own content, so neither should hold up the snapshot.
  const JSON_VIEWER_CONTENT_TYPES: ReadonlySet<string> = new Set([
    'application/json',
    'application/fhir+json',
    'application/ld+json',
  ])
  // `pageLoadHandler` is registered both as a `load` event listener
  // (called with the `Event` object as its first arg) and self-invoked
  // for the retry path (called with a numeric `attempt`). The typed
  // union and the explicit `typeof` narrow lets one function serve
  // both call sites without a wrapper that would shadow the symbol
  // `resetShims` cleans up.
  const pageLoadHandler = (attemptOrEvent: number | Event = 0): void => {
    const attempt = typeof attemptOrEvent === 'number' ? attemptOrEvent : 0
    // The only case that needs a deferred snapshot is the JSON-family
    // viewer: WebKit builds its `<pre>{json}</pre>` body a frame or two
    // after `load` fires, so a synchronous snapshot would capture an
    // empty shell. HTML and XML are fully parsed by the time `load`
    // fires, so they snapshot immediately — judging readiness off the
    // live DOM (`querySelector('pre')`) rather than a serialized string
    // also means a multi-MB document isn't re-serialized on every retry
    // attempt; `outerHTML` is taken once below, only when we commit to
    // emitting.
    //
    // `document.contentType` is a string per the DOM spec; the optional
    // cast guards jsdom edge cases where it has been shadowed by a
    // property descriptor.
    // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- intentional runtime guard
    const contentType = String(document.contentType ?? '')
    const jsonViewerNotReady =
      JSON_VIEWER_CONTENT_TYPES.has(contentType) && document.querySelector('pre') === null
    const shouldRetry =
      attempt < MAX_PAGE_LOAD_RETRIES &&
      typeof win.requestAnimationFrame === 'function' &&
      jsonViewerNotReady
    if (shouldRetry) {
      win.requestAnimationFrame(() => {
        win.requestAnimationFrame(() => {
          pageLoadHandler(attempt + 1)
        })
      })
      return
    }
    const content = document.documentElement.outerHTML
    const pageContentId = makeRequestId()
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

  // Host→Web bridge messages arrive on the single multiplexed
  // `BRIDGE_EVENT` Tauri channel; demux by the payload's `_tag` field.
  // Tags this listener doesn't recognize (other slices' host→web
  // traffic, our own outbound echo from the same broadcast bus, etc.)
  // are dropped silently. Tauri's IPC is the only thing that can
  // invoke this listener, so page scripts can't spoof inbound
  // messages.
  //
  // On a mid-stream cancel we emit `Cancelled` as the terminal
  // observation so the host can release per-id state without
  // waiting for a `ResponseFinished` that won't come.
  //
  // `Click` runs `document.querySelector(querySelector)?.click()` —
  // best-effort, no feedback on a missing element (the host
  // typically retries by waiting for the next `PageLoaded` to land
  // before re-sending).
  const unlistens: Array<(() => void) | Promise<() => void>> = []
  unlistens.push(
    eventBus.listen(BRIDGE_EVENT, ({ payload }) => {
      if (payload === null || typeof payload !== 'object') return
      const msg = payload as Partial<SnifferInboundMessage>
      if (msg._tag === 'CancelSnifferRequest') {
        if (typeof msg.id !== 'string') return
        const wasActive = activeRequests.has(msg.id)
        activeRequests.delete(msg.id)
        if (wasActive) {
          post({ _tag: 'Cancelled', id: msg.id })
        }
        return
      }
      if (msg._tag === 'Click') {
        if (typeof msg.querySelector !== 'string' || msg.querySelector.length === 0) return
        const target = document.querySelector(msg.querySelector)
        if (target !== null && 'click' in target && typeof target.click === 'function') {
          target.click()
        }
        return
      }
    })
  )

  winWithState[stateKey] = {
    nativeFetch,
    nativeXHROpen,
    nativeXHRSend,
    activeRequests,
    pageLoadHandler,
    unlistens,
  }
  // `logError` is captured for use by future top-level error sinks;
  // referencing it here keeps the local binding from being optimized
  // away by the IIFE bundler.
  void logError
}

export { BRIDGE_EVENT, installSniffer, SNIFFER_STATE_KEY }
export type { SnifferInboundMessage, SnifferOutboundMessage, SnifferState }
